import { auth, db, doc, onSnapshot, onAuthStateChanged, sendEmailVerification, firestoreErrorHtml } from "./firebase.js";
import { ensureUserProfile, friendlyAuthError } from "./account.js";
import { adminStatus } from "./admin.js";
import { formatNaira, formatDate, describeTransaction, watchMyTransactions } from "./wallet.js";
import { watchActiveListings } from "./marketplace.js";
import {
  ensureReferralCode, referralLink, affiliateLink, watchMyReferrals,
  watchMyAffiliateApplication, applyForAffiliate, REWARD_TYPES
} from "./referrals.js";

import { syncReferralVerification, watchOwnReferral, watchReferralClaims, REFERRAL_STATUS } from "./referral-rewards.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let currentUser = null;
let code = "";
let application = null;
let listingsStarted = false;
let applicationLoaded = false;

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.href = "login.html"; return; }
  currentUser = user;
  try {
    await ensureUserProfile(user);
    await syncReferralVerification(user);
    code = await ensureReferralCode(user);
    $("myCode").textContent = code;
    $("invitationLink").value = referralLink(code);
    $("loadingScreen").hidden = true;
    $("app").hidden = false;
    adminStatus(user).then((status) => { $("adminLink").hidden = !status.isAdmin; });
    startFeeds();
  } catch (error) {
    console.error(error);
    $("loadingScreen").innerHTML = `<div class="empty">${firestoreErrorHtml(error, "your referral account")}</div>`;
  }
});

function startFeeds() {
  onSnapshot(doc(db, "users", currentUser.uid), (snap) => {
    $("availableCash").textContent = snap.exists() ? formatNaira(snap.data().balance) : "Unavailable";
  }, () => { $("availableCash").textContent = "Unavailable"; });
  watchOwnReferral(currentUser, (r) => {
    $("ownReferralStatus").innerHTML = r ? `<div class="notice ${r.status === "approved" ? "good" : "info"}">Your own invitation: <strong>${esc(REFERRAL_STATUS[r.status] || "Unverified")}</strong>. ${r.status === "unverified" ? "Verify your sign-in email below, then the team can review your referral." : "Rewards from your activity are subject to the referral’s review status."}${r.reviewReason ? " " + esc(r.reviewReason) : ""}</div>` : "";
  }, (error) => { $("ownReferralStatus").innerHTML = firestoreErrorHtml(error, "your referral review"); });
  watchReferralClaims((claims) => {
    $("pendingTotal").textContent = formatNaira(claims.filter((c) => c.status === "pending").reduce((sum, c) => sum + c.amount, 0));
    $("pendingRewardHistory").innerHTML = !claims.length ? '<div class="empty"><p>No held rewards. Eligible activity will appear here when recorded.</p></div>'
      : `<table class="tbl"><thead><tr><th>Reward</th><th>Amount</th><th>Review</th></tr></thead><tbody>${claims.map((c) => `<tr><td>${esc(c.reference)}<br><span class="small">${esc(formatDate(c.createdAt))}${c.type === "lifetime_commission" ? " · " + esc(c.ratePercent) + "% of " + esc(formatNaira(c.baseAmount)) : ""}</span></td><td>${esc(formatNaira(c.amount))}</td><td><span class="status ${esc(c.status)}">${esc(c.status)}</span>${c.rejectionReason ? "<br>" + esc(c.rejectionReason) : ""}</td></tr>`).join("")}</tbody></table>`;
  }, (error) => { $("pendingTotal").textContent = "Unavailable"; $("pendingRewardHistory").innerHTML = firestoreErrorHtml(error, "pending rewards"); });
  watchMyReferrals((referrals) => {
    $("referralCount").textContent = referrals.length;
    $("successfulCount").textContent = referrals.filter((r) => r.status === "approved").length;
    $("emailCount").textContent = referrals.filter((r) => r.emailSaleId).length;
    $("purchaseCount").textContent = referrals.filter((r) => r.purchaseOrderId).length;
    $("referralList").innerHTML = !referrals.length
      ? '<div class="empty"><div class="big">Your first invitation starts here</div><p>Share your registration link to get started.</p></div>'
      : `<table class="tbl"><thead><tr><th>Invitee / review</th><th>Email reward</th><th>Purchase reward</th></tr></thead><tbody>${referrals.map((r) => `
          <tr><td>${esc(r.displayName || "Member")}<br><span class="small">${esc(formatDate(r.joinedAt))}</span><br><span class="status ${esc(r.status || "unverified")}">${esc(REFERRAL_STATUS[r.status] || "Unverified")}</span><br><span class="small">Lifetime ${esc(r.lifetimeRatePercent || 4)}%${r.reviewReason ? " · " + esc(r.reviewReason) : ""}</span></td>
          <td>${r.emailSaleId ? '<span class="status completed">₦200 credited</span>' : `<span class="small">${r.firstPaidEmailSaleId ? "Reward held for review" : "Awaiting first paid sale"}</span>`}</td>
          <td>${r.purchaseOrderId ? '<span class="status completed">₦500 credited</span>' : `<span class="small">${r.firstCompletedOrderId ? "Awaiting review" : "Awaiting first delivery"}</span>`}</td></tr>`).join("")}</tbody></table>`;
  }, (error) => { $("successfulCount").textContent = "Unavailable"; $("referralList").innerHTML = firestoreErrorHtml(error, "your invitations"); });

  watchMyTransactions((transactions) => {
    const credits = transactions.filter((tx) => REWARD_TYPES.includes(tx.type) && tx.status === "completed");
    $("rewardTotal").textContent = formatNaira(credits.reduce((n, tx) => n + tx.amount, 0));
    $("rewardHistory").innerHTML = !credits.length
      ? '<div class="empty"><div class="big">No program credits yet</div><p>Qualifying rewards will appear here once paid into your wallet.</p></div>'
      : `<table class="tbl"><thead><tr><th>Date</th><th>Reward</th><th>Amount</th></tr></thead><tbody>${credits.map((tx) => {
          const description = describeTransaction(tx);
          return `<tr><td class="small">${esc(formatDate(tx.createdAt))}</td><td>${esc(description.label)}<br><span class="small">${esc(description.detail)}</span></td><td class="mono">${esc(description.amount)}</td></tr>`;
        }).join("")}</tbody></table>`;
  }, (error) => {
    $("rewardTotal").textContent = "Unavailable";
    $("rewardHistory").innerHTML = firestoreErrorHtml(error, "your program credits");
  });

  $("affiliateForm").hidden = true;
  watchMyAffiliateApplication((value) => {
    application = value;
    applicationLoaded = true;
    renderApplication();
  }, (error) => {
    $("affiliateStatus").innerHTML = firestoreErrorHtml(error, "your affiliate application");
    $("affiliateForm").hidden = true;
  });
}

function renderApplication() {
  if (!applicationLoaded) return;
  const status = application?.status || "not applied";
  $("affiliateStatus").innerHTML = `<p class="hint">Status: <span class="status ${esc(application?.status || "paused")}">${esc(status)}</span></p>` +
    (application?.rejectionReason ? `<div class="notice info">${esc(application.rejectionReason)}</div>` : "");
  const canApply = !application || status === "rejected";
  $("affiliateForm").hidden = !canApply;
  $("applyBtn").disabled = !currentUser.emailVerified;
  $("verificationNotice").hidden = currentUser.emailVerified;
  $("affiliateShare").hidden = status !== "approved";
  if (status === "pending") $("affiliateStatus").innerHTML += '<div class="notice info">Your application is with the team. Your affiliate link becomes available after approval.</div>';
  if (status === "suspended") $("affiliateStatus").innerHTML += '<div class="notice warn">New sales cannot use your code while access is suspended. Contact the team for a review.</div>';
  if (status === "approved") {
    updateAffiliateLink();
    if (!listingsStarted) {
      listingsStarted = true;
      watchActiveListings((listings) => {
        const selected = $("affiliateItem").value;
        $("affiliateItem").innerHTML = '<option value="">The whole marketplace</option>' + listings
          .filter((l) => l.sellerUid !== currentUser.uid)
          .map((l) => `<option value="${esc(l.id)}">${esc(l.title)}</option>`).join("");
        if ([...$("affiliateItem").options].some((o) => o.value === selected)) $("affiliateItem").value = selected;
        updateAffiliateLink();
      }, (error) => { $("affiliateMsg").innerHTML = firestoreErrorHtml(error, "items to promote"); });
    }
  }
}
function updateAffiliateLink() { $("affiliateLink").value = affiliateLink(code, $("affiliateItem").value); }
$("affiliateItem").addEventListener("change", updateAffiliateLink);

$("affiliateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("applyBtn").disabled = true;
  try {
    await applyForAffiliate({ promotionPlan: $("promotionPlan").value, acceptedTerms: $("affiliateTerms").checked });
    $("affiliateMsg").innerHTML = '<div class="notice good">Application submitted. We’ll review it before activating your sales links.</div>';
  } catch (error) {
    $("affiliateMsg").innerHTML = `<div class="notice bad">${esc(error.message)}</div>`;
  } finally { renderApplication(); }
});

$("sendVerification").addEventListener("click", async () => {
  $("sendVerification").disabled = true;
  try {
    await sendEmailVerification(currentUser);
    $("affiliateMsg").innerHTML = '<div class="notice good">Check your inbox (and spam folder), follow the verification link, then tap “I’ve verified my email”.</div>';
  } catch (error) {
    $("affiliateMsg").innerHTML = `<div class="notice bad">${esc(friendlyAuthError(error, "send a verification email"))}</div>`;
  } finally { $("sendVerification").disabled = false; }
});
$("refreshVerification").addEventListener("click", async () => {
  $("refreshVerification").disabled = true;
  try {
    await currentUser.reload();
    await currentUser.getIdToken(true);
    await syncReferralVerification(currentUser);
    renderApplication();
    $("affiliateMsg").innerHTML = `<div class="notice ${currentUser.emailVerified ? "good" : "info"}">${currentUser.emailVerified ? "Email verified. You can now apply." : "Your email is not verified yet. Open the link in your inbox first."}</div>`;
  } catch (error) { $("affiliateMsg").textContent = friendlyAuthError(error); }
  finally { $("refreshVerification").disabled = false; }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const input = $(button.dataset.copy);
  if (!input.value) return;
  try {
    await navigator.clipboard.writeText(input.value);
    $("copyMsg").innerHTML = '<div class="notice good">Link copied. You’re ready to share.</div>';
  } catch {
    input.focus(); input.select();
    $("copyMsg").innerHTML = '<div class="notice info">Link selected — copy it from the field above.</div>';
  }
});
