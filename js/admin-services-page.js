import { auth, onAuthStateChanged, firestoreErrorHtml } from "./firebase.js";
import { adminStatus, showAccessCheckFailure } from "./admin.js";
import { formatNaira, formatDate } from "./wallet.js";
import { watchSocialOffers, watchRentalCategories, watchServiceRequests, saveSocialOffer, saveRentalCategory,
  completeSocialRequest, assignRental, completeRental, rejectServiceRequest, SERVICE_STATUS } from "./services.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let adminUser = null, offers = [], categories = [], social = [], rentals = [];
const busy = new Set();
function message(id, value, kind = "info") { $(id).innerHTML = `<div class="notice ${kind}">${esc(value)}</div>`; }
function empty(value) { return `<div class="empty"><p>${esc(value)}</p></div>`; }
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.href = "login.html"; return; }
  const access = await adminStatus(user);
  if (!access.isAdmin) { if (access.error) return showAccessCheckFailure(access.error); location.href = "dashboard.html"; return; }
  adminUser = user; $("loadingScreen").hidden = true; $("app").hidden = false;
  watchSocialOffers((rows) => { offers = rows; renderCatalog(); }, (error) => { $("socialOfferList").innerHTML = firestoreErrorHtml(error, "social offers"); }, true);
  watchRentalCategories((rows) => { categories = rows; renderCatalog(); }, (error) => { $("rentalCategoryList").innerHTML = firestoreErrorHtml(error, "rental categories"); }, true);
  watchServiceRequests("socialRequests", (rows) => { social = rows; renderRequests(); }, (error) => { $("socialReviewList").innerHTML = firestoreErrorHtml(error, "social requests"); }, true);
  watchServiceRequests("rentals", (rows) => { rentals = rows; renderRequests(); }, (error) => { $("rentalReviewList").innerHTML = firestoreErrorHtml(error, "rental requests"); }, true);
});
document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll("[data-tab]").forEach((other) => other.classList.toggle("active", other === tab));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === "panel-" + tab.dataset.tab));
}));
function renderCatalog() {
  $("catalogCount").textContent = offers.filter((o) => o.active).length + " / " + categories.filter((c) => c.active).length;
  $("socialOfferList").innerHTML = offers.length ? offers.map((o) => `<article class="reward-row catalog-admin-row"><div><h4>${esc(o.title)} <span class="status ${o.active ? "active" : "paused"}">${o.active ? "Open" : "Closed"}</span></h4><p>${esc(o.platform)} · ${esc(o.stock)} units\nCustomer price ${esc(formatNaira(o.sellPrice))}</p></div><button class="btn small ghost" data-edit-offer="${esc(o.id)}">Edit</button></article>`).join("") : empty("No social accounts for sale yet. Create the first customer offer below.");
  $("rentalCategoryList").innerHTML = categories.length ? categories.map((c) => `<article class="reward-row catalog-admin-row"><div><h4>${esc(c.name)} <span class="status ${c.active ? "active" : "paused"}">${c.active ? "Available" : "Closed"}</span></h4><p>${esc(formatNaira(c.price))} / code · manual inbox</p></div><button class="btn small ghost" data-edit-category="${esc(c.id)}">Edit</button></article>`).join("") : empty("No rental categories. Set a price and availability below.");
}
function include(r) {
  const status = $("requestFilter").value;
  return !status || (status === "open" ? ["pending", "awaiting_code"].includes(r.status) : r.status === status);
}
function renderRequests() {
  $("socialCount").textContent = social.filter((r) => r.status === "pending").length;
  $("rentalCount").textContent = rentals.filter((r) => r.status === "pending").length;
  $("codeCount").textContent = rentals.filter((r) => r.status === "awaiting_code").length;
  const socialRows = social.filter(include), rentalRows = rentals.filter(include);
  $("socialReviewList").innerHTML = socialRows.length ? socialRows.slice(0, 60).map(socialRow).join("") : empty("No matching social requests.");
  $("rentalReviewList").innerHTML = rentalRows.length ? rentalRows.slice(0, 60).map(rentalRow).join("") : empty("No matching rentals.");
}
function socialRow(r) {
  const inboundLegacy = r.side !== "buy";
  const requestLabel = inboundLegacy ? "Legacy inbound request (no longer offered)" : "Customer purchase";
  const actions = r.status !== "pending" ? "" : inboundLegacy
    ? `<div class="notice warn">MailMart no longer accepts social-account sales from users. Reject this legacy request; do not settle it.</div><button class="btn small ghost" type="button" data-reject-kind="socialRequests" data-id="${esc(r.id)}" ${busy.has(r.id) ? "disabled" : ""}>Reject legacy request</button>`
    : `<form data-social-complete="${esc(r.id)}"><div class="field"><label>Platform-permitted handoff reference<input name="reference" minlength="5" maxlength="800" required autocomplete="off" placeholder="Transfer confirmation/reference. No credentials."></label></div><label class="reward-check"><input name="reviewed" type="checkbox" required><span>I verified MailMart’s entitlement, stock and platform permission, completed the authorized handoff, and verified the buyer. This debits the customer’s quoted amount; recheck balance before handover.</span></label><div class="row-end"><button class="btn small good" type="submit" ${busy.has(r.id) ? "disabled" : ""}>Complete & charge customer</button><button class="btn small ghost" type="button" data-reject-kind="socialRequests" data-id="${esc(r.id)}" ${busy.has(r.id) ? "disabled" : ""}>Reject</button></div></form>`;
  const reference = r.transferReference ? ` · Transfer reference: ${esc(r.transferReference)}` : "";
  const reason = r.rejectionReason ? ` · Reason: ${esc(r.rejectionReason)}` : "";
  return `<article class="reward-row"><h4>${requestLabel} · ${esc(r.title)}</h4><p>${esc(r.email || r.uid)} · ${esc(formatDate(r.createdAt))} · Quoted amount ${esc(formatNaira(r.amount))} · <span class="status ${esc(r.status)}">${esc(SERVICE_STATUS[r.status] || r.status)}</span>${reference}${reason}</p>${actions}</article>`;
}
function rentalRow(r) {
  let actions = "";
  if (r.status === "pending") actions = `<form data-rental-assign="${esc(r.id)}"><div class="field"><label>Authorized Gmail inbox<input name="inbox" type="email" maxlength="254" required autocomplete="off" placeholder="your-authorized-inbox@gmail.com"></label></div><label class="reward-check"><input type="checkbox" name="authorized" required><span>I control this inbox or have permission to provide it, and the request is an authorized non-financial use. Reserve ${esc(formatNaira(r.amount))} for one code now.</span></label><div class="row-end"><button class="btn small good" type="submit" ${busy.has(r.id) ? "disabled" : ""}>Assign & reserve payment</button><button type="button" class="btn small ghost" data-reject-kind="rentals" data-id="${esc(r.id)}">Reject</button></div></form>`;
  if (r.status === "awaiting_code") actions = `<form data-rental-complete="${esc(r.id)}"><div class="field"><label>Code received at the assigned authorized inbox<input name="code" minlength="4" maxlength="64" required autocomplete="off" spellcheck="false" placeholder="Only the requested code, not a password or email body"></label></div><p class="service-private">PRIVATE · IN-APP CODE ACCESS EXPIRES AFTER 10 MINUTES</p><div class="request-actions"><button class="btn small good" type="submit" ${busy.has(r.id) ? "disabled" : ""}>Deliver code & finalize</button><button type="button" class="btn small ghost" data-reject-kind="rentals" data-id="${esc(r.id)}">Cannot fulfil · refund</button></div></form>`;
  return `<article class="reward-row"><h4>${esc(r.categoryName)} · one code · ${esc(formatNaira(r.amount))}</h4><p>${esc(r.email || r.uid)} · ${esc(formatDate(r.createdAt))}\n<span class="status ${esc(r.status)}">${esc(SERVICE_STATUS[r.status] || r.status)}</span>\nAuthorized purpose: ${esc(r.purpose)}${r.inbox ? "\nAssigned inbox: " + esc(r.inbox) : ""}${r.rejectionReason ? "\nReason: " + esc(r.rejectionReason) : ""}${r.completedAt ? "\nDelivered: " + esc(formatDate(r.completedAt)) : ""}</p>${actions}</article>`;
}
$("requestFilter").addEventListener("change", renderRequests);
$("offerForm").addEventListener("submit", async (event) => {
  event.preventDefault(); $("offerSave").disabled = true;
  try {
    await saveSocialOffer({ id: $("offerId").value, title: $("offerTitle").value, platform: $("offerPlatform").value,
      description: $("offerDescription").value, buyPrice: 0, sellPrice: $("offerCustomerPrice").value,
      stock: $("offerStock").value, active: $("offerActive").checked }, adminUser);
    $("offerForm").reset(); $("offerId").value = ""; message("offerMsg", "Admin prices and availability saved. Existing requests retain their accepted price.", "good");
  } catch (error) { message("offerMsg", error.message, "bad"); }
  finally { $("offerSave").disabled = false; }
});
$("categoryForm").addEventListener("submit", async (event) => {
  event.preventDefault(); $("categorySave").disabled = true;
  try {
    await saveRentalCategory({ id: $("categoryId").value, name: $("categoryName").value, description: $("categoryDescription").value,
      price: $("categoryPrice").value, active: $("categoryActive").checked }, adminUser);
    $("categoryForm").reset(); $("categoryId").value = ""; message("categoryMsg", "Category saved. The minimum is enforced at ₦50; existing requests keep their quoted price.", "good");
  } catch (error) { message("categoryMsg", error.message, "bad"); }
  finally { $("categorySave").disabled = false; }
});
$("newOffer").addEventListener("click", () => { $("offerForm").reset(); $("offerId").value = ""; $("offerMsg").textContent = ""; });
$("newCategory").addEventListener("click", () => { $("categoryForm").reset(); $("categoryId").value = ""; $("categoryMsg").textContent = ""; });
document.addEventListener("click", async (event) => {
  const offer = event.target.closest("[data-edit-offer]");
  const category = event.target.closest("[data-edit-category]");
  const reject = event.target.closest("[data-reject-kind]");
  if (offer) {
    const o = offers.find((row) => row.id === offer.dataset.editOffer); if (!o) return;
    $("offerId").value = o.id; $("offerTitle").value = o.title; $("offerPlatform").value = o.platform; $("offerDescription").value = o.description;
    $("offerCustomerPrice").value = o.sellPrice; $("offerStock").value = o.stock; $("offerActive").checked = o.active;
    $("offerEditor").open = true; $("offerEditor").scrollIntoView({ block: "center" }); return;
  }
  if (category) {
    const c = categories.find((row) => row.id === category.dataset.editCategory); if (!c) return;
    $("categoryId").value = c.id; $("categoryName").value = c.name; $("categoryDescription").value = c.description; $("categoryPrice").value = c.price; $("categoryActive").checked = c.active;
    $("categoryEditor").open = true; $("categoryEditor").scrollIntoView({ block: "center" }); return;
  }
  if (!reject || !adminUser || busy.has(reject.dataset.id)) return;
  const reason = prompt("Rejection/refund reason (visible to the requester). Any reserved, unfulfilled rental payment will be refunded exactly once.");
  if (reason === null || !reason.trim()) return;
  const id = reject.dataset.id; busy.add(id); renderRequests();
  try { await rejectServiceRequest(reject.dataset.rejectKind, id, reason, adminUser); message("actionMsg", "Request reviewed. Any reserved rental funds were returned to the customer.", "good"); }
  catch (error) { message("actionMsg", error.message, "bad"); }
  finally { busy.delete(id); renderRequests(); }
});
document.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-social-complete], [data-rental-assign], [data-rental-complete]");
  if (!form || !adminUser) return;
  event.preventDefault();
  const id = form.dataset.socialComplete || form.dataset.rentalAssign || form.dataset.rentalComplete;
  if (busy.has(id)) return;
  const data = new FormData(form);
  if (!confirm("Commit this reviewed service action? Wallet, ledger and request changes are atomic.")) return;
  busy.add(id); form.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    if (form.dataset.socialComplete) await completeSocialRequest({ requestId: id, transferReference: data.get("reference"), ownershipReviewed: data.get("reviewed") === "on", adminUser });
    else if (form.dataset.rentalAssign) await assignRental({ rentalId: id, inbox: data.get("inbox"), authorizedMailbox: data.get("authorized") === "on", adminUser });
    else { await completeRental({ rentalId: id, code: data.get("code"), adminUser }); form.reset(); }
    message("actionMsg", "Service action completed and recorded in the private request and wallet ledger.", "good");
  } catch (error) { message("actionMsg", error.message, "bad"); }
  finally { busy.delete(id); renderRequests(); }
});
