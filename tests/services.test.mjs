import test from "node:test";
import assert from "node:assert/strict";
import { createApp, admin, profile, referral } from "./helpers/firebase-mock.mjs";
const user = (uid = "buyer", emailVerified = true) => ({ uid, email: uid + "@example.com", emailVerified, reload: async () => {}, getIdToken: async () => "token" });
const offer = { title: "Authorized business asset", platform: "Instagram", description: "Reviewed authorized business transfer only.", buyPrice: 300, sellPrice: 500, stock: 1, active: true, authorizedTransfersOnly: true, createdAt: 1 };
const category = { name: "Instagram registration", description: "Authorized tests/own registrations, manual availability.", price: 50, active: true, manualOnly: true, createdAt: 1 };
function seed(extra = {}) { return { "users/buyer": profile("buyer", 5000, "referrer"), "users/referrer": profile("referrer", 100), "referrals/buyer": referral(), "socialOffers/offer": offer, "rentalCategories/category": category, ...extra }; }
const request = (services, side = "buy") => services.requestSocial({ offerId: "offer", side, accountUrl: "https://www.instagram.com/owned-business/", ownershipNote: "I manage this business and can use its authorized transfer process.", acceptedTerms: true });
const complete = (services, id) => services.completeSocialRequest({ requestId: id, ownershipReviewed: true, transferReference: "Authorized transfer reference #123", adminUser: admin });
const rental = (services) => services.requestRental({ categoryId: "category", purpose: "Registration for my own authorized test", acceptedTerms: true });
const assign = (services, id, inbox = "owned.inbox+one@gmail.com") => services.assignRental({ rentalId: id, inbox, authorizedMailbox: true, adminUser: admin });

test("admin catalogs enforce fixed prices, stock bounds and the per-code ₦50 minimum", async () => {
  const app = await createApp(seed(), { user: user() }); const services = await app.load("js/services.js");
  for (const price of [49.99, -1, Infinity, NaN]) await assert.rejects(services.saveRentalCategory({ ...category, price }, admin));
  const id = await services.saveRentalCategory({ ...category, price: 75 }, admin);
  assert.equal(app.data("rentalCategories/" + id).price, 75);
  await assert.rejects(services.saveSocialOffer({ ...offer, stock: 1.5 }, admin), /whole number/);
  await assert.rejects(services.saveSocialOffer({ ...offer, platform: "made up" }, admin), /platform/);
  const socialId = await services.saveSocialOffer(offer, admin);
  assert.equal(app.data("socialOffers/" + socialId).buyPrice, 300); assert.equal(app.data("socialOffers/" + socialId).sellPrice, 500);
});

test("social requests require verified email, authorization, terms and owned HTTPS asset details", async () => {
  const app = await createApp(seed(), { user: user("buyer", false) }); const services = await app.load("js/services.js");
  await assert.rejects(request(services), /Verify/);
  app.auth.currentUser = user();
  await assert.rejects(services.requestSocial({ offerId: "offer", side: "buy", acceptedTerms: false }), /Confirm/);
  await assert.rejects(services.requestSocial({ offerId: "offer", side: "sell", acceptedTerms: true, accountUrl: "javascript:alert(1)", ownershipNote: "My authorized asset" }), /HTTPS/);
  await assert.rejects(services.requestSocial({ offerId: "offer", side: "sell", acceptedTerms: true, accountUrl: "https://instagram.com/owned", ownershipNote: "no" }), /explanation/);
  await assert.rejects(services.requestSocial({ offerId: "offer", side: "sell", acceptedTerms: true, accountUrl: "https://username:secret@instagram.com/owned", ownershipNote: "My authorized business asset" }), /HTTPS/);
  const before = app.all(); await assert.rejects(services.completeSocialRequest({ requestId: "missing", ownershipReviewed: false, transferReference: "ref", adminUser: admin }), /Confirm/); assert.deepEqual(app.all(), before);
});

test("buying a social asset charges the accepted admin price only after review, once, with lifetime spending", async () => {
  const app = await createApp(seed(), { user: user() }); const services = await app.load("js/services.js");
  const r = await request(services);
  assert.equal(app.data("users/buyer").balance, 5000); assert.equal(app.data("socialRequests/" + r.id).amount, 500);
  await services.saveSocialOffer({ ...offer, id: "offer", sellPrice: 700 }, admin);
  await complete(services, r.id);
  assert.equal(app.data("users/buyer").balance, 4500); assert.equal(app.data("socialOffers/offer").stock, 0);
  assert.equal(app.data("transactions/social_buy_" + r.id).amount, 500);
  assert.equal(app.data("referralClaims/lifetime_social_buy_" + r.id).amount, 20);
  await assert.rejects(complete(services, r.id), /no longer pending/);
  await (await app.load("js/referral-rewards.js")).releaseReferralClaim("lifetime_social_buy_" + r.id, admin);
  assert.equal(app.data("users/referrer").balance, 120);
});

test("selling a social asset pays the quoted earnings, not a user-supplied amount, and increases reviewed stock", async () => {
  const app = await createApp(seed(), { user: user() }); const services = await app.load("js/services.js");
  const r = await request(services, "sell"); await complete(services, r.id);
  assert.equal(app.data("users/buyer").balance, 5300); assert.equal(app.data("socialOffers/offer").stock, 2);
  const tx = app.data("transactions/social_sell_" + r.id); assert.equal(tx.type, "social_sale"); assert.equal(tx.amount, 300);
  assert.equal(app.data("referralClaims/lifetime_social_sell_" + r.id).amount, 12);
  for (const name of ["password", "sessionCookie", "cookie", "recoveryCode"]) assert.equal(Object.hasOwn(app.data("socialRequests/" + r.id), name), false);
});

test("competing social purchases cannot oversell the last unit, and failed settlements fully roll back", async () => {
  const app = await createApp(seed({ "users/second": profile("second", 5000) }), { user: user() }); const services = await app.load("js/services.js");
  const first = await request(services); app.auth.currentUser = user("second"); const second = await request(services);
  const results = await Promise.allSettled([complete(services, first.id), complete(services, second.id)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); assert.equal(app.data("socialOffers/offer").stock, 0);
  assert.equal(app.data("users/buyer").balance + app.data("users/second").balance, 9500);
  const other = await createApp(seed(), { user: user() }); const otherServices = await other.load("js/services.js"); const r = await request(otherServices);
  other.failOn("transactions/social_buy_" + r.id); const before = other.all();
  await assert.rejects(complete(otherServices, r.id), /refusal/); assert.deepEqual(other.all(), before);
});

test("an unfunded social purchase is never completed if the balance was spent after its request", async () => {
  const app = await createApp(seed(), { user: user() }); const services = await app.load("js/services.js"); const r = await request(services);
  const sdk = await app.load("js/firebase.js"); await sdk.updateDoc(sdk.doc(sdk.db, "users", "buyer"), { balance: 499 });
  const before = app.all(); await assert.rejects(complete(services, r.id), /sufficient balance/); assert.deepEqual(app.all(), before);
});

test("rental enforces category price >=₦50, sufficient available funds and verified authorized use", async () => {
  for (const balance of [0, 49.99]) {
    const app = await createApp(seed({ "users/buyer": profile("buyer", balance, "referrer") }), { user: user() });
    await assert.rejects(rental(await app.load("js/services.js")), /at least/);
  }
  const app = await createApp(seed({ "rentalCategories/category": { ...category, price: 75 }, "users/buyer": profile("buyer", 50, "referrer") }), { user: user() });
  const services = await app.load("js/services.js"); await assert.rejects(rental(services), /at least/);
  app.auth.currentUser = user("buyer", false); await assert.rejects(rental(services), /Verify/);
});

test("manual inbox assignment atomically reserves one code price; delivery finalizes it without another debit", async () => {
  const app = await createApp(seed({ "users/buyer": profile("buyer", 50, "referrer") }), { user: user() }); const services = await app.load("js/services.js");
  const r = await rental(services); assert.equal(app.data("users/buyer").balance, 50);
  await assign(services, r.id); assert.equal(app.data("users/buyer").balance, 0);
  assert.equal(app.data("transactions/rental_payment_" + r.id).status, "approved");
  assert.equal(app.data("referralClaims/lifetime_rental_payment_" + r.id), undefined);
  await services.completeRental({ rentalId: r.id, code: "123456", adminUser: admin });
  assert.equal(app.data("users/buyer").balance, 0);
  assert.equal(app.data("transactions/rental_payment_" + r.id).status, "completed");
  assert.equal(app.data("referralClaims/lifetime_rental_payment_" + r.id).amount, 2);
  assert.equal((await services.loadRentalCode(r.id)).code, "123456");
  assert.equal(app.data("rentals/" + r.id).code, undefined); assert.equal(app.data("transactions/rental_payment_" + r.id).code, undefined);
  const code = app.data("rentalCodes/" + r.id); assert.ok(code.expiresAt.getTime() > Date.now());
  assert.ok(code.expiresAt.getTime() <= Date.now() + 10 * 60 * 1000);
  await assert.rejects(services.completeRental({ rentalId: r.id, code: "654321", adminUser: admin }), /not waiting/);
  await assert.rejects(assign(services, r.id), /no longer pending/);
});

test("Gmail dot/plus/Googlemail aliases cannot bypass mailbox exclusivity or customer binding", async () => {
  const app = await createApp(seed({ "users/second": profile("second", 5000) }), { user: user() }); const services = await app.load("js/services.js");
  assert.equal(services.canonicalGmail("Owned.Inbox+tag@googlemail.com").key, "gmail-ownedinbox");
  await assert.rejects(assign(services, "missing", "someone@other.com"), /Gmail/);
  const first = await rental(services); await assign(services, first.id);
  const sameCustomer = await rental(services); await assert.rejects(assign(services, sameCustomer.id, "ownedinbox@gmail.com"), /already bound/);
  await services.completeRental({ rentalId: first.id, code: "123456", adminUser: admin });
  app.auth.currentUser = user("second"); const second = await rental(services);
  const before = app.all(); await assert.rejects(assign(services, second.id, "o.wnedinbox+other@googlemail.com"), /already bound/); assert.deepEqual(app.all(), before);
  assert.equal(app.data("rentalInboxes/gmail-ownedinbox").ownerUid, "buyer");
});

test("unfulfilled rental rejection refunds only reserved funds, exactly once, and never earns a lifetime reward", async () => {
  const app = await createApp(seed(), { user: user() }); const services = await app.load("js/services.js"); const r = await rental(services);
  await assign(services, r.id); assert.equal(app.data("users/buyer").balance, 4950);
  await services.rejectServiceRequest("rentals", r.id, "No authorized code arrived", admin);
  assert.equal(app.data("users/buyer").balance, 5000); assert.equal(app.data("rentals/" + r.id).status, "refunded");
  assert.equal(app.data("transactions/rental_refund_" + r.id).amount, 50);
  assert.equal(app.data("transactions/rental_payment_" + r.id).status, "refunded");
  assert.equal(app.data("referralClaims/lifetime_rental_payment_" + r.id), undefined);
  await assert.rejects(services.rejectServiceRequest("rentals", r.id, "Retry", admin), /Only pending/);
  await assert.rejects(services.completeRental({ rentalId: r.id, code: "123456", adminUser: admin }), /not waiting/);
});

test("pending rejection charges nothing; expired codes cannot be loaded; failed code delivery rolls everything back", async () => {
  const app = await createApp(seed({ "rentalCodes/expired": { uid: "buyer", code: "123456", expiresAt: new Date(Date.now() - 1000) } }), { user: user() });
  const services = await app.load("js/services.js");
  await assert.rejects(services.loadRentalCode("expired"), /expired/);
  const r = await rental(services); await services.rejectServiceRequest("rentals", r.id, "Unsupported purpose", admin);
  assert.equal(app.data("users/buyer").balance, 5000); assert.equal(app.data("rentals/" + r.id).status, "rejected");
  const other = await rental(services); await assign(services, other.id); app.failOn("rentalCodes/" + other.id);
  const before = app.all(); await assert.rejects(services.completeRental({ rentalId: other.id, code: "123456", adminUser: admin }), /refusal/); assert.deepEqual(app.all(), before);
});

test("assignment rechecks available balance and concurrent assignment never debits twice", async () => {
  const app = await createApp(seed(), { user: user() }); const services = await app.load("js/services.js"); const r = await rental(services);
  const tries = await Promise.allSettled([assign(services, r.id), assign(services, r.id)]);
  assert.equal(tries.filter((r) => r.status === "fulfilled").length, 1); assert.equal(app.data("users/buyer").balance, 4950);
  const other = await rental(services); const sdk = await app.load("js/firebase.js");
  await sdk.updateDoc(sdk.doc(sdk.db, "users", "buyer"), { balance: 49.99 });
  const before = app.all(); await assert.rejects(assign(services, other.id, "otherauthorized@gmail.com"), /required balance/); assert.deepEqual(app.all(), before);
});

test("a price change after the displayed quote requires renewed consent, not a silent request reprice", async () => {
  const app = await createApp(seed(), { user: user() }); const services = await app.load("js/services.js");
  const before = app.all();
  await assert.rejects(services.requestSocial({ offerId: "offer", side: "buy", acceptedTerms: true, expectedAmount: 499 }), /price changed/);
  await assert.rejects(services.requestRental({ categoryId: "category", purpose: "My authorized test registration", acceptedTerms: true, expectedAmount: 75 }), /price changed/);
  assert.deepEqual(app.all(), before);
});
