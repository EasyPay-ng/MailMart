import { auth, db, doc, onSnapshot, onAuthStateChanged, firestoreErrorHtml } from "./firebase.js";
import { ensureUserProfile } from "./account.js";
import { adminStatus } from "./admin.js";
import { syncReferralVerification } from "./referral-rewards.js";
import { formatNaira, formatDate } from "./wallet.js";
import { watchSocialOffers, watchRentalCategories, watchServiceRequests, requestSocial, requestRental, cancelServiceRequest, loadRentalCode, SERVICE_STATUS } from "./services.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let offers = [], categories = [], selectedOffer = null;
let socialBusy = false, rentalBusy = false, rentalQuoteKey = "";
function message(id, value, kind = "info") { $(id).innerHTML = `<div class="notice ${kind}">${esc(value)}</div>`; }
function empty(value) { return `<div class="empty"><p>${esc(value)}</p></div>`; }
function showTab(name) {
  document.querySelectorAll("[data-tab]").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === "panel-" + name));
}
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.href = "login.html"; return; }
  try {
    await ensureUserProfile(user);
    await syncReferralVerification(user);
    $("loadingScreen").hidden = true; $("app").hidden = false;
    adminStatus(user).then((s) => { $("adminLink").hidden = !s.isAdmin; });
    onSnapshot(doc(db, "users", user.uid), (snap) => { $("walletBalance").textContent = snap.exists() ? formatNaira(snap.data().balance) : "Unavailable"; }, () => { $("walletBalance").textContent = "Unavailable"; });
    watchSocialOffers((rows) => { offers = rows; renderOffers(); }, (error) => { $("socialCatalog").innerHTML = firestoreErrorHtml(error, "social offers"); });
    watchRentalCategories((rows) => {
      categories = rows;
      const selected = $("rentalCategory").value;
      $("rentalCategory").innerHTML = '<option value="">Choose an available category</option>' + rows.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} — ${esc(formatNaira(c.price))}/code</option>`).join("");
      if (rows.some((r) => r.id === selected)) $("rentalCategory").value = selected;
      renderRentalQuote();
    }, (error) => { $("rentalMsg").innerHTML = firestoreErrorHtml(error, "rental categories"); $("rentalSubmit").disabled = true; });
    watchServiceRequests("socialRequests", (rows) => { $("socialRequests").innerHTML = rows.length ? rows.map(socialRow).join("") : empty("No social requests yet."); }, (error) => { $("socialRequests").innerHTML = firestoreErrorHtml(error, "your social requests"); });
    watchServiceRequests("rentals", (rows) => { $("rentalRequests").innerHTML = rows.length ? rows.map(rentalRow).join("") : empty("No Gmail code rentals yet."); }, (error) => { $("rentalRequests").innerHTML = firestoreErrorHtml(error, "your code rentals"); });
  } catch (error) { $("loadingScreen").innerHTML = `<div class="empty">${firestoreErrorHtml(error, "services")}</div>`; }
});
function renderOffers() {
  $("socialCatalog").innerHTML = offers.length ? offers.map((o) => `<article class="service-offer"><span class="platform-chip">${esc(o.platform === "X" ? "X / formerly Twitter" : o.platform)}</span><h3>${esc(o.title)}</h3><p>${esc(o.description)}</p><div class="offer-prices"><div><span>Customer price</span><strong>${o.sellPrice > 0 ? esc(formatNaira(o.sellPrice)) : "Unavailable"}</strong></div></div><p>${o.stock > 0 ? esc(o.stock) + " available · manually reviewed handoff" : "Currently out of stock"}</p><div class="row-end"><button class="btn small" data-offer="${esc(o.id)}" ${o.stock < 1 || o.sellPrice <= 0 ? "disabled" : ""}>Request to buy</button></div></article>`).join("") : empty("No social accounts are available for purchase yet. MailMart will post an offer when stock is ready.");
}
function socialRow(r) {
  const legacyInbound = r.side !== "buy";
  const label = legacyInbound ? "Legacy inbound request" : "Purchase request";
  const notice = legacyInbound && r.status === "pending" ? '<div class="notice warn">MailMart no longer accepts social-account sales from users. Cancel this legacy request; no payment will be made.</div>' : "";
  const reason = r.rejectionReason ? " · " + esc(r.rejectionReason) : "";
  const reference = r.transferReference ? " · Transfer reference: " + esc(r.transferReference) : "";
  return `<article class="reward-row"><h4>${label} · ${esc(r.title)}</h4><p>${esc(formatNaira(r.amount))} · ${esc(formatDate(r.createdAt))} · <span class="status ${esc(r.status)}">${esc(SERVICE_STATUS[r.status] || r.status)}</span>${reason}${reference}</p>${notice}${r.status === "pending" ? `<button class="btn small ghost" data-cancel="socialRequests" data-id="${esc(r.id)}">Cancel pending request</button>` : ""}</article>`;
}
function rentalRow(r) {
  return `<article class="reward-row"><h4>${esc(r.categoryName)} · one code</h4><p>${esc(formatNaira(r.amount))} · ${esc(formatDate(r.createdAt))}\n<span class="status ${esc(r.status)}">${esc(SERVICE_STATUS[r.status] || r.status)}</span>${r.inbox ? "\nAssigned inbox: " + esc(r.inbox) : "\nAwaiting manual review and inbox assignment"}${r.status === "awaiting_code" ? "\nPayment reserved; awaiting manual code delivery." : ""}${r.rejectionReason ? "\n" + esc(r.rejectionReason) : ""}${r.codeExpiresAt ? "\nCode available until " + esc(formatDate(r.codeExpiresAt)) : ""}</p><div class="request-actions">${r.status === "pending" ? `<button class="btn small ghost" data-cancel="rentals" data-id="${esc(r.id)}">Cancel pending request</button>` : ""}${r.status === "completed" ? `<button class="btn small good" data-reveal="${esc(r.id)}">Reveal private code</button>` : ""}</div><div data-code-slot class="service-code" role="status" aria-live="polite"></div></article>`;
}
document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
$("socialCatalog").addEventListener("click", (event) => {
  const button = event.target.closest("[data-offer]");
  if (!button) return;
  selectedOffer = offers.find((o) => o.id === button.dataset.offer);
  if (!selectedOffer) return;
  $("socialRequestForm").reset(); $("socialMsg").textContent = "";
  $("socialRequestTitle").textContent = `Buy · ${selectedOffer.title}`;
  $("socialRequestQuote").textContent = `You pay ${formatNaira(selectedOffer.sellPrice)} after an approved handoff. This request is not charged until MailMart completes its review.`;
  $("socialRequestCard").hidden = false; $("socialRequestCard").scrollIntoView({ block: "center", behavior: "smooth" });
});
$("socialClose").addEventListener("click", () => { $("socialRequestCard").hidden = true; });
$("socialRequestForm").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!selectedOffer || socialBusy) return;
  socialBusy = true; $("socialSubmit").disabled = true;
  try {
    await requestSocial({ offerId: selectedOffer.id, side: "buy", acceptedTerms: $("socialTerms").checked, expectedAmount: selectedOffer.sellPrice });
    $("socialRequestForm").reset(); message("socialMsg", "Request submitted at the current admin price. It is not charged/paid until admin completes the reviewed transfer. Track it in My requests.", "good");
  } catch (error) { message("socialMsg", error.message, "bad"); }
  finally { socialBusy = false; $("socialSubmit").disabled = false; }
});
function renderRentalQuote() {
  const c = categories.find((row) => row.id === $("rentalCategory").value);
  const key = c ? c.id + ":" + c.price : "";
  if (key !== rentalQuoteKey) $("rentalTerms").checked = false;
  rentalQuoteKey = key;
  $("rentalPrice").textContent = c ? formatNaira(c.price) + " / code" : "Select an available category";
  $("rentalDescription").textContent = c?.description || (categories.length ? "" : "Admin has not opened a category yet. No inboxes are generated automatically.");
  $("rentalSubmit").disabled = rentalBusy || !c;
}
$("rentalCategory").addEventListener("change", renderRentalQuote);
$("rentalRequestForm").addEventListener("submit", async (event) => {
  event.preventDefault(); if (rentalBusy) return;
  rentalBusy = true; renderRentalQuote();
  try {
    await requestRental({ categoryId: $("rentalCategory").value, purpose: $("rentalPurpose").value, acceptedTerms: $("rentalTerms").checked, expectedAmount: categories.find((row) => row.id === $("rentalCategory").value)?.price ?? null });
    $("rentalRequestForm").reset(); message("rentalMsg", "One-code request submitted. Admin will review your use, recheck the balance and manually assign an authorized inbox. Track it in My requests.", "good");
  } catch (error) { message("rentalMsg", error.message, "bad"); }
  finally { rentalBusy = false; renderRentalQuote(); }
});
document.addEventListener("click", async (event) => {
  const cancel = event.target.closest("[data-cancel]");
  const reveal = event.target.closest("[data-reveal]");
  const button = cancel || reveal;
  if (!button || button.disabled) return;
  if (cancel && !confirm("Cancel this pending request? No payment has been reserved yet.")) return;
  button.disabled = true;
  try {
    if (cancel) { await cancelServiceRequest(cancel.dataset.cancel, cancel.dataset.id); message("pageMsg", "Pending request cancelled.", "good"); }
    else {
      const data = await loadRentalCode(reveal.dataset.reveal);
      const slot = button.closest(".reward-row").querySelector("[data-code-slot]");
      slot.textContent = data.code;
      const expires = data.expiresAt?.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
      setTimeout(() => { slot.textContent = "Code expired"; }, Math.max(0, expires.getTime() - Date.now()));
    }
  } catch (error) { message("pageMsg", error.message, "bad"); button.disabled = false; }
});
