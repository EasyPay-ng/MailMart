import { auth, onAuthStateChanged, firestoreErrorHtml } from "./firebase.js";
import { adminStatus, showAccessCheckFailure } from "./admin.js";
import { watchAllOrders } from "./marketplace.js";
import { formatNaira, formatDate } from "./wallet.js";
import { affiliateCommissionFor } from "./referral-policy.js";
import { watchAffiliateApplications, reviewAffiliate, settleOrderRewards } from "./referrals.js";

import { watchAllReferrals, watchReferralClaims, watchReferralAudit, reviewReferral, releaseReferralClaim, rejectReferralClaim, REFERRAL_STATUS } from "./referral-rewards.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let adminUser = null;
let applications = [];
let orders = [];
let referrals = [];
let claims = [];
const busy = new Set();

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.href = "login.html"; return; }
  const access = await adminStatus(user);
  if (!access.isAdmin) {
    if (access.error) return showAccessCheckFailure(access.error);
    location.href = "dashboard.html";
    return;
  }
  adminUser = user;
  $("loadingScreen").hidden = true;
  $("app").hidden = false;
  watchAllReferrals((rows) => { referrals = rows; renderReferrals(); renderClaims(); }, (error) => { $("referralReviewList").innerHTML = firestoreErrorHtml(error, "referral reviews"); });
  watchReferralClaims((rows) => { claims = rows; renderClaims(); }, (error) => { $("heldClaims").innerHTML = firestoreErrorHtml(error, "held rewards"); }, true);
  watchReferralAudit((rows) => {
    $("referralAuditList").innerHTML = rows.length ? rows.slice(0, 60).map((a) => `<article class="reward-row"><h4>${esc(a.refereeUid)} · ${esc(a.fromStatus)} → ${esc(a.status)}</h4><p>${esc(formatDate(a.createdAt))} · ${esc(a.reviewedBy)} · ${esc(a.ratePercent)}%
Risk: ${esc(a.riskReason || "none")}
Public reason: ${esc(a.publicReason || "—")}
Private note: ${esc(a.privateNote || "—")}</p></article>`).join("") : empty("No review decisions yet.");
  }, (error) => { $("referralAuditList").innerHTML = firestoreErrorHtml(error, "private review history"); });
  watchAffiliateApplications((rows) => {
    applications = rows;
    renderApplications();
  }, (error) => { $("pendingApplications").innerHTML = firestoreErrorHtml(error, "affiliate applications"); });
  watchAllOrders((rows) => {
    orders = rows;
    renderOrders();
  }, (error) => { $("rewardOrders").innerHTML = firestoreErrorHtml(error, "completed orders"); });
});

function empty(text) { return `<div class="empty"><p>${esc(text)}</p></div>`; }
function renderApplications() {
  const pending = applications.filter((a) => a.status === "pending");
  $("applicationCount").textContent = pending.length;
  $("pendingApplications").innerHTML = pending.length ? pending.map((a) => `
    <article class="reward-row"><h4>${esc(a.email)}</h4>
      <p>${esc(formatDate(a.createdAt))} · Terms ${esc(a.termsVersion)}</p><p class="plan">${esc(a.promotionPlan)}</p>
      <div class="row-end">
        <button class="btn small good" data-review="approved" data-uid="${esc(a.uid)}" ${busy.has(a.uid) ? "disabled" : ""}>Approve affiliate</button>
        <button class="btn small ghost" data-review="rejected" data-uid="${esc(a.uid)}" ${busy.has(a.uid) ? "disabled" : ""}>Reject</button>
      </div></article>`).join("") : empty("No affiliate applications are waiting.");
  const roster = applications.filter((a) => ["approved", "suspended"].includes(a.status));
  $("affiliateRoster").innerHTML = roster.length ? roster.map((a) => `
    <article class="reward-row"><h4>${esc(a.email)} <span class="status ${esc(a.status)}">${esc(a.status)}</span></h4>
      <p>${esc(a.rejectionReason || "Affiliate access approved")}</p>
      <button class="btn small ghost" data-review="${a.status === "approved" ? "suspended" : "approved"}" data-uid="${esc(a.uid)}" ${busy.has(a.uid) ? "disabled" : ""}>${a.status === "approved" ? "Suspend new sales" : "Reactivate"}</button>
    </article>`).join("") : empty("Approved affiliates will appear here.");
}
function renderOrders() {
  const waiting = orders.filter((o) => o.status === "completed" && o.paidAt && !o.rewardsSettledAt && (o.referrerUid || o.affiliateUid));
  $("orderCount").textContent = waiting.length;
  $("rewardOrders").innerHTML = waiting.length ? waiting.map((o) => `
    <article class="reward-row"><h4>${esc(o.listingTitle || "Goods order")}</h4>
      <p>Buyer: ${esc(o.buyerEmail || o.buyerUid)}
Delivered: ${esc(formatDate(o.completedAt))}
Goods subtotal: ${esc(formatNaira(o.subtotal))}
${o.referrerUid ? "Purchase bonuses: ₦500 referrer + ₦200 buyer, if this is their first completed purchase." : "No registration-referral purchase bonus."}
${o.affiliateUid ? "Affiliate commission: " + esc(formatNaira(affiliateCommissionFor(o.subtotal, Number(o.affiliateRatePercent ?? 5) / 100))) + " (" + esc(o.affiliateRatePercent ?? 5) + "% of goods only; platform-funded)" : "No affiliate attributed."}</p>
      <p class="reward-code">Order ${esc(o.id)}</p>
      <button class="btn small good" data-release="${esc(o.id)}" ${busy.has(o.id) ? "disabled" : ""}>${busy.has(o.id) ? "Releasing…" : "Release eligible rewards"}</button>
    </article>`).join("") : empty("No delivered orders are awaiting reward review.");
}

document.addEventListener("click", async (event) => {
  const review = event.target.closest("[data-review]");
  const release = event.target.closest("[data-release]");
  if (!adminUser || (!review && !release)) return;
  const key = review ? review.dataset.uid : release.dataset.release;
  if (busy.has(key)) return;
  let reason = "";
  if (review) {
    if (["rejected", "suspended"].includes(review.dataset.review)) {
      const reply = prompt("Reason (shown to the applicant):", "");
      if (reply === null) return;
      reason = reply.trim();
      if (!reason) { showMessage("Enter a reason for this decision.", "bad"); return; }
    } else if (!confirm("Approve affiliate access and activate this user's product-rate tracked sales links?")) return;
  } else if (!confirm("Release this delivered order's eligible rewards? Fixed bonuses are paid once per buyer; all credits and balances commit together.")) return;
  busy.add(key);
  renderApplications(); renderOrders();
  try {
    if (review) {
      await reviewAffiliate(key, review.dataset.review, adminUser, reason);
      showMessage("Affiliate decision saved.", "good");
    } else {
      const result = await settleOrderRewards(key, adminUser);
      showMessage(`${formatNaira(result.total)} credited. ${result.held?.length || 0} fixed rewards held for referral approval.`, "good");
    }
  } catch (error) {
    console.error(error);
    if (error.code) $("actionMsg").innerHTML = `<div class="notice bad">${firestoreErrorHtml(error, "that reward action")}</div>`;
    else showMessage(error.message, "bad");
  } finally {
    busy.delete(key);
    renderApplications(); renderOrders();
  }
});
function showMessage(text, kind) { $("actionMsg").innerHTML = `<div class="notice ${kind}">${esc(text)}</div>`; }

function renderReferrals() {
  $("reviewCount").textContent = referrals.filter((r) => !r.status || ["unverified", "pending"].includes(r.status)).length;
  $("flaggedCount").textContent = referrals.filter((r) => r.status === "flagged").length;
  $("approvedCount").textContent = referrals.filter((r) => r.status === "approved").length;
  const filter = $("reviewFilter").value;
  const term = $("reviewSearch").value.trim().toLowerCase();
  const filtered = referrals.filter((r) => (!filter || (r.status || "unverified") === filter) && (!term || `${r.displayName} ${r.refereeUid} ${r.referrerUid}`.toLowerCase().includes(term)));
  $("referralReviewList").innerHTML = filtered.length ? filtered.slice(0, 60).map((r) => `
    <article class="reward-row"><h4>${esc(r.displayName || "Member")} <span class="status ${esc(r.status || "unverified")}">${esc(REFERRAL_STATUS[r.status] || "Unverified")}</span></h4>
    <p class="reward-code">Invitee ${esc(r.refereeUid)}
Inviter ${esc(r.referrerUid)}</p><p>${r.verifiedAt ? "Email verified: " + esc(formatDate(r.verifiedAt)) : "Sign-in email not verified"} · Rate ${esc(r.lifetimeRatePercent || 4)}%${r.reviewReason ? "\n" + esc(r.reviewReason) : ""}</p>
    <details class="review-form"><summary>Review referral / change rate</summary>
      <form data-referral-form="${esc(r.refereeUid)}">
        <div class="two"><div class="field"><label>Decision<select name="status">${["pending", "approved", "flagged", "rejected"].map((v) => `<option value="${v}" ${v === r.status ? "selected" : ""}>${REFERRAL_STATUS[v]}</option>`).join("")}</select></label></div>
        <div class="field"><label>Lifetime commission (%)<input type="number" name="rate" min="4" max="5" step="0.01" value="${esc(r.lifetimeRatePercent || 4)}" required></label></div></div>
        <div class="field"><label>Risk category<select name="risk"><option value="">No risk category</option>${["spam", "bot", "duplicate", "abuse", "other"].map((v) => `<option value="${v}" ${v === r.riskReason ? "selected" : ""}>${v === "abuse" ? "Reward-looting / abuse" : v}</option>`).join("")}</select></label></div>
        <div class="field"><label>Public reason (visible to inviter and invitee)<textarea name="reason" maxlength="500">${esc(r.reviewReason || "")}</textarea></label></div>
        <div class="field"><label>Private admin investigation note<textarea name="privateNote" maxlength="1000" placeholder="Evidence/review notes. Never include credentials or unnecessary personal data."></textarea></label></div>
        <button class="btn small good" type="submit" ${busy.has("relation:" + r.refereeUid) ? "disabled" : ""}>Save review decision</button>
      </form>
    </details></article>`).join("") + (filtered.length > 60 ? '<p class="hint">Showing 60 matches. Narrow the search to find a specific referral.</p>' : "") : empty("No referrals match this filter.");
}
function renderClaims() {
  const waiting = claims.filter((c) => c.status === "pending");
  $("heldAmount").textContent = formatNaira(waiting.reduce((sum, c) => sum + c.amount, 0));
  $("heldClaims").innerHTML = waiting.length ? waiting.map((c) => {
    const relation = referrals.find((r) => r.refereeUid === c.refereeUid);
    return `<article class="reward-row"><h4>${esc(c.reference)} · ${esc(formatNaira(c.amount))}</h4><p>Recipient ${esc(c.uid)}
Invitee ${esc(c.refereeUid)} · ${esc(REFERRAL_STATUS[relation?.status] || "Unverified")}
${c.type === "lifetime_commission" ? esc(c.ratePercent) + "% of " + esc(formatNaira(c.baseAmount)) + " · " + esc(c.sourceType) : "First-activity bonus"}
Source ${esc(c.sourceId)}</p><div class="row-end"><button class="btn small good" data-claim-release="${esc(c.id)}" ${relation?.status !== "approved" || busy.has(c.id) ? "disabled" : ""}>Release reward</button><button class="btn small ghost" data-claim-reject="${esc(c.id)}" ${busy.has(c.id) ? "disabled" : ""}>Reject claim</button></div></article>`;
  }).join("") : empty("There are no held claims awaiting review.");
}
$("reviewFilter").addEventListener("change", renderReferrals);
$("reviewSearch").addEventListener("input", renderReferrals);
document.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-referral-form]");
  if (!form || !adminUser) return;
  event.preventDefault();
  const data = new FormData(form);
  const key = "relation:" + form.dataset.referralForm;
  if (busy.has(key)) return;
  busy.add(key);
  form.querySelector("button").disabled = true;
  try {
    await reviewReferral({ refereeUid: form.dataset.referralForm, status: data.get("status"), ratePercent: data.get("rate"),
      reason: data.get("reason"), riskReason: data.get("risk"), privateNote: data.get("privateNote"), adminUser });
    showMessage("Referral decision saved with a private audit record.", "good");
  } catch (error) { showMessage(error.message, "bad"); }
  finally { busy.delete(key); renderReferrals(); }
});
document.addEventListener("click", async (event) => {
  const release = event.target.closest("[data-claim-release]");
  const reject = event.target.closest("[data-claim-reject]");
  if (!adminUser || (!release && !reject)) return;
  const id = release?.dataset.claimRelease || reject.dataset.claimReject;
  if (busy.has(id)) return;
  let reason = "";
  if (reject) { const reply = prompt("Why should this claim be rejected? Paired purchase bonuses reject together."); if (reply === null) return; reason = reply.trim(); if (!reason) return showMessage("Give a rejection reason.", "bad"); }
  else if (!confirm("Release this reward after validating its source and referral approval? Paired purchase bonuses release together.")) return;
  busy.add(id); renderClaims();
  try {
    if (release) { const result = await releaseReferralClaim(id, adminUser); showMessage(`${formatNaira(result.total)} released to wallet balances.`, "good"); }
    else { await rejectReferralClaim(id, reason, adminUser); showMessage("Claim rejection recorded.", "good"); }
  } catch (error) { showMessage(error.message, "bad"); }
  finally { busy.delete(id); renderClaims(); }
});
