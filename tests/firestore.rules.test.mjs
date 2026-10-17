// Run only against a disposable Firebase emulator, never the production app.
// npm run test:rules starts it with the demo-mailmart project (no credentials).
import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import * as sdk from "firebase/firestore";
import { profile, referral, order, admin } from "./helpers/firebase-mock.mjs";

const root = path.resolve(import.meta.dirname, "..");
let env;
const clientDirectories = [];
const clientStates = new Map();
globalThis.__mailmartRuleClients = clientStates;
const now = () => sdk.serverTimestamp();
const user = (uid, verified = true) => ({ uid, email: uid + "@example.com", emailVerified: verified,
  reload: async () => {}, getIdToken: async () => "test-token" });
function database(uid, verified = true) {
  if (!uid) return env.unauthenticatedContext().firestore();
  return env.authenticatedContext(uid, { email: uid === admin.uid ? admin.email : uid + "@example.com", email_verified: verified }).firestore();
}
async function seed(values) {
  await env.withSecurityRulesDisabled(async (context) => {
    const batch = sdk.writeBatch(context.firestore());
    for (const [key, data] of Object.entries(values)) batch.set(sdk.doc(context.firestore(), key), data);
    await batch.commit();
  });
}
async function client(uid, verified = true) {
  const db = database(uid, verified);
  const currentUser = uid === admin.uid ? admin : user(uid, verified);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mailmart-rules-"));
  clientDirectories.push(directory);
  const key = String(clientDirectories.length);
  clientStates.set(key, { db, user: currentUser });
  // Load unmodified business modules in the native JS realm (Firebase rejects
  // plain objects created in another VM realm). Replace ONLY the SDK boundary
  // with the authenticated emulator context, not any business logic.
  await fs.cp(path.join(root, "js"), path.join(directory, "js"), { recursive: true });
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(directory, "js/firebase.js"), `
    export * from ${JSON.stringify(import.meta.resolve("firebase/firestore"))};
    const state = globalThis.__mailmartRuleClients.get(${JSON.stringify(key)});
    export const db = state.db;
    export const auth = { currentUser: state.user };
    export const firestoreErrorHtml = () => "error";
  `);
  return { db, load: (filename) => import(pathToFileURL(path.join(directory, filename)).href) };
}

const listing = { id: "goods", title: "Discounted goods", description: "Good condition", category: "Other", image: "",
  price: 2000, discountPrice: 1000, stock: 10, deliveryDefault: 300, deliveryByState: {},
  status: "active", sellerUid: "seller", sellerEmail: "seller@example.com", createdAt: 1, updatedAt: 1 };
const checkout = { listing, quantity: 1, address: { state: "Delta", name: "Buyer", phone: "08030000000", lga: "Warri South", street: "Test address" }, settings: { serviceFee: 50 }, affiliateCode: "MM-affiliate" };

before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Start the emulator with npm run test:rules. Production testing is forbidden.");
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  env = await initializeTestEnvironment({ projectId: "demo-mailmart", firestore: { host, port: Number(port), rules: await fs.readFile(path.join(root, "firestore.rules"), "utf8") } });
});
after(async () => {
  if (env) await env.cleanup();
  for (const directory of clientDirectories) await fs.rm(directory, { recursive: true, force: true });
  delete globalThis.__mailmartRuleClients;
});
beforeEach(async () => {
  await env.clearFirestore();
  await seed({
    "users/buyer": profile("buyer", 5000, "referrer"), "users/seller": profile("seller", 200),
    "users/referrer": profile("referrer", 100), "users/affiliate": profile("affiliate", 50),
    "referralCodes/MM-referrer": { uid: "referrer", affiliateActive: false, createdAt: 1, updatedAt: 1 },
    "referralCodes/MM-affiliate": { uid: "affiliate", affiliateActive: true, createdAt: 1, updatedAt: 1 },
    "referrals/buyer": referral(), "listings/goods": listing, "settings/platform": { serviceFee: 50 }
  });
});

test("public exact code lookup is allowed; code enumeration and private profile reads are forbidden", async () => {
  const publicDb = database(null);
  await assertSucceeds(sdk.getDoc(sdk.doc(publicDb, "referralCodes/MM-referrer")));
  await assertFails(sdk.getDocs(sdk.collection(publicDb, "referralCodes")));
  await assertFails(sdk.getDoc(sdk.doc(publicDb, "users/referrer")));
  const referrerDb = database("referrer");
  await assertSucceeds(sdk.getDocs(sdk.query(sdk.collection(referrerDb, "referrals"), sdk.where("referrerUid", "==", "referrer"))));
  await assertFails(sdk.getDoc(sdk.doc(referrerDb, "users/buyer")));
  await assertFails(sdk.getDoc(sdk.doc(database("outsider"), "referrals/buyer")));
});

test("real profile creation writes paired referral/code documents, no balance or affiliate privilege", async () => {
  const c = await client("new-user");
  const refs = await c.load("js/referrals.js");
  refs.rememberRegistrationReferral("MM-referrer"); refs.bindRegistrationReferral(user("new-user"));
  const accounts = await c.load("js/account.js");
  await assertSucceeds(accounts.ensureUserProfile(user("new-user")));
  const data = (await sdk.getDoc(sdk.doc(c.db, "users/new-user"))).data();
  assert.equal(data.balance, 0); assert.equal(data.referredBy, "referrer");
  assert.equal((await sdk.getDoc(sdk.doc(c.db, "referralCodes/MM-new-user"))).data().affiliateActive, false);
  await assertFails(sdk.updateDoc(sdk.doc(c.db, "users/new-user"), { balance: 200 }));
  await assertFails(sdk.updateDoc(sdk.doc(c.db, "users/new-user"), { referredBy: "affiliate" }));
});

test("profile creation rejects injected roles, balance, milestone fields, self- or nonexistent referrer", async () => {
  for (const extra of [{ isSubAdmin: true }, { isAffiliate: true }, { balance: 500 }, { emailSaleId: "fake" }, { referredBy: "new-user" }, { referredBy: "missing" }]) {
    const db = database("new-user");
    const batch = sdk.writeBatch(db);
    batch.set(sdk.doc(db, "users/new-user"), { ...profile("new-user"), createdAt: now(), updatedAt: now(), ...extra });
    batch.set(sdk.doc(db, "referralCodes/MM-new-user"), { uid: "new-user", affiliateActive: false, createdAt: now(), updatedAt: now() });
    await assertFails(batch.commit());
  }
});

test("verified applications can be submitted but only administrators can approve/activate", async () => {
  const unverified = await client("buyer", false);
  const verified = await client("buyer", true);
  const app = { promotionPlan: "Share with my community", acceptedTerms: true };
  const unverifiedRefs = await unverified.load("js/referrals.js");
  await assert.rejects(unverifiedRefs.applyForAffiliate(app), /Verify/);
  await assertFails(sdk.setDoc(sdk.doc(unverified.db, "affiliateApplications/buyer"), {
    uid: "buyer", email: "buyer@example.com", promotionPlan: app.promotionPlan, acceptedTerms: true,
    termsVersion: "2026-10", termsAcceptedAt: now(), status: "pending", createdAt: now(), updatedAt: now()
  }));
  const refs = await verified.load("js/referrals.js");
  await assertSucceeds(refs.ensureReferralCode(user("buyer")));
  await assertSucceeds(refs.applyForAffiliate(app));
  await assertFails(sdk.updateDoc(sdk.doc(verified.db, "affiliateApplications/buyer"), { status: "approved", updatedAt: now() }));
  await assertFails(sdk.updateDoc(sdk.doc(verified.db, "referralCodes/MM-buyer"), { affiliateActive: true, updatedAt: now() }));
  const a = await client(admin.uid); const adminRefs = await a.load("js/referrals.js");
  await assertSucceeds(adminRefs.reviewAffiliate("buyer", "approved", admin));
  await assertSucceeds(adminRefs.reviewAffiliate("buyer", "suspended", admin, "Review"));
  assert.equal((await sdk.getDoc(sdk.doc(verified.db, "referralCodes/MM-buyer"))).data().affiliateActive, false);
});

test("full checkout -> payment -> shipping -> completion -> reward release obeys deployed rules", async () => {
  const buyer = await client("buyer"); const buyerMarket = await buyer.load("js/marketplace.js");
  const id = await assertSucceeds(buyerMarket.placeOrder(checkout));
  const placed = (await sdk.getDoc(sdk.doc(buyer.db, "orders", id))).data();
  const a = await client(admin.uid); const adminMarket = await a.load("js/marketplace.js");
  await assertSucceeds(adminMarket.settleOrderPayment({ ...placed, id }, admin));
  const seller = await client("seller"); const sellerMarket = await seller.load("js/marketplace.js");
  await assertSucceeds(sellerMarket.saveOrderDeliveryProof(id, { photo: "data:image/jpeg;base64," + "p".repeat(300), signature: "data:image/jpeg;base64," + "s".repeat(150), recipientName: "Buyer Name", note: "Handed over" }));
  await assertSucceeds(sellerMarket.advanceOrder({ id }, "shipped", "seller@example.com"));
  await assertSucceeds(buyerMarket.advanceOrder({ id }, "completed", "buyer@example.com"));
  const adminRefs = await a.load("js/referrals.js");
  await assertSucceeds(adminRefs.settleOrderRewards(id, admin));
  assert.equal((await sdk.getDoc(sdk.doc(buyer.db, "users/buyer"))).data().balance, 3850);
  assert.equal((await sdk.getDoc(sdk.doc(a.db, "users/referrer"))).data().balance, 600);
  assert.equal((await sdk.getDoc(sdk.doc(a.db, "users/affiliate"))).data().balance, 100);
  assert.equal((await sdk.getDoc(sdk.doc(a.db, "users/seller"))).data().balance, 1500);
  await assert.rejects(adminRefs.settleOrderRewards(id, admin), /already been reviewed/);
  await assertFails(sdk.updateDoc(sdk.doc(a.db, "transactions", "affiliate_" + id), { amount: 999 }));
});

test("order chat is private to buyer, seller and admins, and messages are sender-bound and immutable", async () => {
  const buyer = await client("buyer"); const market = await buyer.load("js/marketplace.js");
  const id = await assertSucceeds(market.placeOrder(checkout));
  await assertSucceeds(market.sendOrderMessage(id, "Can you confirm the colour before dispatch?"));
  const seller = await client("seller"); const sellerMarket = await seller.load("js/marketplace.js");
  await assertSucceeds(sellerMarket.sendOrderMessage(id, "Yes, the item is black as listed."));
  await assertSucceeds(sdk.getDocs(sdk.collection(seller.db, "orders", id, "messages")));
  const outsider = database("outsider");
  await assertFails(sdk.getDocs(sdk.collection(outsider, "orders", id, "messages")));
  await assertFails(sdk.setDoc(sdk.doc(buyer.db, "orders", id, "messages/fake"), {
    uid: "seller", email: "seller@example.com", text: "Impersonation", createdAt: now()
  }));
  await assertFails(sdk.updateDoc(sdk.doc(buyer.db, "orders", id, "messages", "fake"), { text: "Edited" }));
});

test("attribution and quote cannot be changed after checkout; buyer cannot approve or release rewards", async () => {
  const c = await client("buyer"); const market = await c.load("js/marketplace.js");
  const id = await market.placeOrder(checkout);
  for (const patch of [{ affiliateUid: "buyer" }, { subtotal: 1 }, { referrerUid: null }, { paymentTxId: "fake" }, { rewardsSettledAt: now() }, { status: "paid", paidAt: now() }]) {
    await assertFails(sdk.updateDoc(sdk.doc(c.db, "orders", id), { ...patch, updatedAt: now() }));
  }
  const refs = await c.load("js/referrals.js");
  await seed({ "affiliateApplications/affiliate": { uid: "affiliate", status: "pending" } });
  await assertFails(refs.reviewAffiliate("affiliate", "approved", user("buyer")));
  await assertFails(sdk.setDoc(sdk.doc(c.db, "transactions/fake"), {
    type: "purchase_welcome", direction: "credit", status: "completed", uid: "buyer", email: "buyer@example.com", amount: 200,
    balanceAfter: 5200, reference: "fake", sourceUid: "buyer", orderId: id, reviewedBy: "buyer@example.com", reviewedAt: now(), createdAt: now(), updatedAt: now()
  }));
});

test("a fake delivery milestone without completing a shipped order is refused", async () => {
  const db = database("buyer");
  await seed({ "orders/one": order("one", { status: "paid" }) });
  await assertFails(sdk.updateDoc(sdk.doc(db, "referrals/buyer"), { firstCompletedOrderId: "one", firstPurchaseCompletedAt: now(), updatedAt: now() }));
  await assertFails(sdk.updateDoc(sdk.doc(db, "orders/one"), { status: "completed", completedAt: now(), updatedAt: now() }));
});

test("admin email payout and one-time referral reward commit together under real rules", async () => {
  await seed({ "sales/s1": { uid: "buyer", status: "approved", email: "sold@example.com" } });
  const a = await client(admin.uid); const wallet = await a.load("js/wallet.js");
  await assertSucceeds(wallet.payEmailSale({ sale: { id: "s1", uid: "buyer" }, amount: 1000, adminUser: admin }));
  assert.equal((await sdk.getDoc(sdk.doc(a.db, "users/referrer"))).data().balance, 300);
  assert.equal((await sdk.getDoc(sdk.doc(a.db, "transactions/email_referral_buyer"))).data().amount, 200);
});

test("even an administrator's referral ledger entry is rejected if the source amount is wrong", async () => {
  await seed({ "orders/one": order(), "referrals/buyer": referral("buyer", "referrer", { firstCompletedOrderId: "one", firstPurchaseCompletedAt: 6 }) });
  const db = database(admin.uid); const batch = sdk.writeBatch(db);
  batch.update(sdk.doc(db, "orders/one"), { rewardsSettledAt: now(), updatedAt: now() });
  batch.update(sdk.doc(db, "referrals/buyer"), { purchaseOrderId: "one", purchaseRewardPaidAt: now(), updatedAt: now() });
  batch.update(sdk.doc(db, "users/referrer"), { balance: 1099, updatedAt: now() });
  batch.set(sdk.doc(db, "transactions/purchase_referral_buyer"), {
    type: "purchase_referral", direction: "credit", status: "completed", uid: "referrer", email: "referrer@example.com",
    amount: 999, balanceAfter: 1099, sourceUid: "buyer", orderId: "one", reference: "First purchase",
    reviewedBy: admin.email, reviewedAt: now(), createdAt: now(), updatedAt: now()
  });
  await assertFails(batch.commit());
  assert.equal((await sdk.getDoc(sdk.doc(db, "users/referrer"))).data().balance, 100);
});

test("referral email verification is server-checked, separate from audited admin approval and private notes", async () => {
  await seed({ "referrals/buyer": referral("buyer", "referrer", { status: "unverified", verifiedAt: null }) });
  const unverified = database("buyer", false);
  await assertFails(sdk.updateDoc(sdk.doc(unverified, "referrals/buyer"), { status: "pending", verifiedAt: now(), updatedAt: now() }));
  const buyer = await client("buyer"); const rewards = await buyer.load("js/referral-rewards.js");
  await assertSucceeds(rewards.syncReferralVerification(user("buyer")));
  await assertFails(sdk.updateDoc(sdk.doc(buyer.db, "referrals/buyer"), { status: "approved", lifetimeRatePercent: 5, updatedAt: now() }));
  const a = await client(admin.uid); const adminRewards = await a.load("js/referral-rewards.js");
  await assertSucceeds(adminRewards.reviewReferral({ refereeUid: "buyer", status: "approved", ratePercent: 4.5, privateNote: "Private review evidence", adminUser: admin }));
  const audit = await sdk.getDocs(sdk.collection(a.db, "referralAudit"));
  assert.equal(audit.size, 1); assert.equal(audit.docs[0].data().privateNote, "Private review evidence");
  await assertFails(sdk.getDoc(sdk.doc(database("referrer"), "referralAudit", audit.docs[0].id)));
  await assertFails(sdk.updateDoc(audit.docs[0].ref, { privateNote: "rewrite history" }));
  await assertFails(sdk.updateDoc(sdk.doc(a.db, "referrals/buyer"), { lifetimeRatePercent: 5.01, updatedAt: now() }));
});

test("held email and lifetime rewards release only after approval, with immutable source-linked credits", async () => {
  await seed({ "referrals/buyer": referral("buyer", "referrer", { status: "pending" }), "sales/s1": { uid: "buyer", status: "approved" } });
  const a = await client(admin.uid); const wallet = await a.load("js/wallet.js"); const rewards = await a.load("js/referral-rewards.js");
  await assertSucceeds(wallet.payEmailSale({ sale: { id: "s1", uid: "buyer" }, amount: 1000, adminUser: admin }));
  assert.equal((await sdk.getDoc(sdk.doc(a.db, "users/referrer"))).data().balance, 100);
  await assertSucceeds(sdk.getDoc(sdk.doc(database("referrer"), "referralClaims/email_referral_buyer")));
  await assertFails(sdk.getDoc(sdk.doc(database("outsider"), "referralClaims/email_referral_buyer")));
  await assert.rejects(rewards.releaseReferralClaim("email_referral_buyer", admin), /Approve/);
  await assertSucceeds(rewards.reviewReferral({ refereeUid: "buyer", status: "approved", ratePercent: 5, adminUser: admin }));
  await assertSucceeds(rewards.releaseReferralClaim("email_referral_buyer", admin));
  await assertSucceeds(rewards.releaseReferralClaim("lifetime_email_payout_s1", admin));
  assert.equal((await sdk.getDoc(sdk.doc(a.db, "users/referrer"))).data().balance, 340); // event's 4%, not future 5%
  await assertFails(sdk.updateDoc(sdk.doc(a.db, "transactions/lifetime_email_payout_s1"), { amount: 999 }));
});

test("deposits/reward credits cannot be forged into lifetime claims, even by a hand-crafted admin write", async () => {
  await seed({ "transactions/credit": { uid: "buyer", type: "admin_credit", status: "completed", amount: 1000 } });
  const db = database(admin.uid);
  await assertFails(sdk.setDoc(sdk.doc(db, "referralClaims/lifetime_credit"), {
    uid: "referrer", refereeUid: "buyer", referrerUid: "referrer", type: "lifetime_commission",
    sourceKind: "transaction", sourceId: "credit", sourceType: "admin_credit", amount: 40, baseAmount: 1000, ratePercent: 4,
    reference: "Fake recursive credit", status: "pending", createdBy: admin.email, createdAt: now(), updatedAt: now()
  }));
  await assertFails(sdk.setDoc(sdk.doc(database("buyer"), "referralClaims/fake"), { uid: "buyer", amount: 50, status: "pending" }));
});

test("real four-week plans enforce warehouse verification, dynamic amounts, stock reservation and full-payment delivery", async () => {
  const planListing = { ...listing, variants: ["Black", "Silver"], installmentEnabled: true, installmentDelivery: "after_full",
    installmentUnit: "week", installmentCount: 4, installmentMonths: 0, warehouseRequired: true, warehouseVerified: true };
  await seed({ "listings/goods": planListing });
  const buyer = await client("buyer"), seller = await client("seller"), a = await client(admin.uid);
  const market = await buyer.load("js/marketplace.js"), sellerMarket = await seller.load("js/marketplace.js"), adminMarket = await a.load("js/marketplace.js");
  const id = await assertSucceeds(market.placeOrder({ ...checkout, listing: planListing, selectedVariant: "Black", paymentMode: "installment" }));
  const placed = (await sdk.getDoc(sdk.doc(buyer.db, "orders", id))).data();
  assert.equal(placed.installmentCount, 4); assert.equal(placed.installmentUnit, "week"); assert.equal(placed.selectedVariant, "Black");
  assert.equal((await sdk.getDoc(sdk.doc(buyer.db, "transactions", placed.paymentTxId))).data().amount, 337.5);
  await assertFails(sdk.updateDoc(sdk.doc(seller.db, "listings/goods"), { warehouseVerified: false, updatedAt: now() }));
  await assertFails(sdk.updateDoc(sdk.doc(buyer.db, "orders", id), { totalPaid: 1350, installmentsPaid: 4, updatedAt: now() }));
  await assertSucceeds(adminMarket.settleOrderPayment({ ...placed, id }, admin, placed.paymentTxId));
  assert.equal((await sdk.getDoc(sdk.doc(a.db, "users/seller"))).data().balance, 525);
  await assertFails(sellerMarket.advanceOrder({ id }, "shipped", "seller@example.com"));
  await assert.rejects(sellerMarket.saveOrderDeliveryProof(id, { photo: "x".repeat(300), signature: "y".repeat(150), recipientName: "Buyer" }), /full payment/);
  await assertFails(market.advanceOrder({ id }, "completed", "buyer@example.com"));
  await assertFails(sdk.setDoc(sdk.doc(buyer.db, "transactions", id + "_month_2"), {
    type: "order_payment", direction: "debit", status: "pending", uid: "buyer", email: "buyer@example.com",
    amount: 1, installmentNumber: 2, orderId: id, reference: "Tampered installment price", createdAt: now(), updatedAt: now()
  }));
  const adminRewards = await a.load("js/referral-rewards.js");
  await assert.rejects(adminRewards.releaseReferralClaim("lifetime_" + placed.paymentTxId, admin));
  for (let number = 2; number <= 4; number++) {
    const request = await assertSucceeds(market.requestInstallmentPayment(id));
    assert.equal((await sdk.getDoc(sdk.doc(buyer.db, "transactions", request.id))).data().amount, 337.5);
    await assertSucceeds(adminMarket.settleOrderPayment({ ...placed, id }, admin, request.id));
  }
  await assertSucceeds(sellerMarket.saveOrderDeliveryProof(id, { photo: "data:image/jpeg;base64," + "p".repeat(300), signature: "data:image/jpeg;base64," + "s".repeat(150), recipientName: "Buyer Name", note: "Handed over" }));
  await assertSucceeds(sellerMarket.advanceOrder({ id }, "shipped", "seller@example.com"));
  await assertSucceeds(market.advanceOrder({ id }, "completed", "buyer@example.com"));
  const final = (await sdk.getDoc(sdk.doc(buyer.db, "orders", id))).data();
  assert.equal(final.status, "completed"); assert.equal(final.totalPaid, 1350); assert.equal(final.sellerPaid, 1300);
  assert.equal((await sdk.getDoc(sdk.doc(a.db, "users/seller"))).data().balance, 1500);
  const remainingStock = (await sdk.getDoc(sdk.doc(a.db, "listings/goods"))).data().stock;
  assert.equal(remainingStock, 9); // reserved once on first settlement, not once per week
  await assertSucceeds(adminRewards.releaseReferralClaim("lifetime_" + placed.paymentTxId, admin));
  await assertSucceeds((await a.load("js/referrals.js")).settleOrderRewards(id, admin));
  assert.equal((await sdk.getDoc(sdk.doc(buyer.db, "users/buyer"))).data().balance, 3850);
  await assert.rejects(market.requestInstallmentPayment(id), /active instalment|paid in full/);
});

test("admin-priced social customer purchases are private, cannot forge quotes or self-settle, and user-to-MailMart sales are denied", async () => {
  const a = await client(admin.uid); const adminServices = await a.load("js/services.js");
  const offerId = await assertSucceeds(adminServices.saveSocialOffer({ title: "MailMart social account", platform: "Instagram", description: "Business assets with platform-permitted customer transfer only.", buyPrice: 300, sellPrice: 500, stock: 1, active: true }, admin));
  assert.equal((await sdk.getDoc(sdk.doc(a.db, "socialOffers", offerId))).data().buyPrice, 0);
  await seed({ "socialRequests/legacy": {
    uid: "buyer", email: "buyer@example.com", offerId, platform: "Instagram", title: "MailMart social account",
    side: "sell", amount: 300, accountUrl: "https://instagram.com/owned-business",
    ownershipNote: "Previously accepted authorized business asset.", acceptedTerms: true,
    status: "pending", createdAt: new Date(), updatedAt: new Date()
  } });
  await assertFails(sdk.updateDoc(sdk.doc(a.db, "socialRequests", "legacy"), {
    status: "completed", ownershipReviewed: true, transferReference: "Legacy transfer reference",
    reviewedBy: admin.email, reviewedAt: now(), updatedAt: now()
  }));
  const buyer = await client("buyer"); const services = await buyer.load("js/services.js");
  const request = await assertSucceeds(services.requestSocial({ offerId, side: "buy", acceptedTerms: true }));
  await assertFails(sdk.getDoc(sdk.doc(database("outsider"), "socialRequests", request.id)));
  await assertFails(sdk.updateDoc(sdk.doc(buyer.db, "socialRequests", request.id), { amount: 1, updatedAt: now() }));
  await assertFails(services.completeSocialRequest({ requestId: request.id, ownershipReviewed: true, transferReference: "fake transfer ref", adminUser: user("buyer") }));
  await assertSucceeds(adminServices.completeSocialRequest({ requestId: request.id, ownershipReviewed: true, transferReference: "Reviewed authorized business transfer #123", adminUser: admin }));
  assert.equal((await sdk.getDoc(sdk.doc(buyer.db, "users/buyer"))).data().balance, 4500);
  await assertSucceeds((await a.load("js/referral-rewards.js")).releaseReferralClaim("lifetime_social_buy_" + request.id, admin));
  await assert.rejects(adminServices.completeSocialRequest({ requestId: request.id, ownershipReviewed: true, transferReference: "duplicate #123", adminUser: admin }), /no longer pending/);
  const inbound = sdk.addDoc(sdk.collection(buyer.db, "socialRequests"), {
    uid: "buyer", email: "buyer@example.com", offerId, platform: "Instagram", title: "MailMart social account",
    side: "sell", amount: 300, accountUrl: "https://instagram.com/owned-business",
    ownershipNote: "I own and manage this authorized business asset.", acceptedTerms: true,
    status: "pending", createdAt: now(), updatedAt: now()
  });
  await assertFails(inbound);
  await assert.rejects(services.requestSocial({ offerId, side: "sell", acceptedTerms: true }), /customer purchases only/);
  assert.equal((await sdk.getDoc(sdk.doc(buyer.db, "users/buyer"))).data().balance, 4500);
});

test("manual Gmail rentals reserve/finalize/refund once and codes stay private, unlistable and unreadable after expiry", async () => {
  const a = await client(admin.uid), buyer = await client("buyer");
  const adminServices = await a.load("js/services.js"), services = await buyer.load("js/services.js");
  const categoryId = await assertSucceeds(adminServices.saveRentalCategory({ name: "Authorized registration", description: "Authorized own registration or test; manual inbox provision.", price: 50, active: true }, admin));
  await assertFails(sdk.updateDoc(sdk.doc(buyer.db, "rentalCategories", categoryId), { price: 1, updatedAt: now() }));
  await assertFails(sdk.updateDoc(sdk.doc(a.db, "rentalCategories", categoryId), { price: 49.99, updatedAt: now(), updatedBy: admin.email }));
  const values = { categoryId, purpose: "Registration of my own authorized test account", acceptedTerms: true };
  const request = await assertSucceeds(services.requestRental(values));
  await assertFails(sdk.getDoc(sdk.doc(database("outsider"), "rentals", request.id)));
  await assertSucceeds(adminServices.assignRental({ rentalId: request.id, inbox: "owned.inbox+one@gmail.com", authorizedMailbox: true, adminUser: admin }));
  assert.equal((await sdk.getDoc(sdk.doc(buyer.db, "users/buyer"))).data().balance, 4950);
  await assertFails(sdk.getDoc(sdk.doc(buyer.db, "rentalInboxes/gmail-ownedinbox")));
  await assertFails(sdk.updateDoc(sdk.doc(a.db, "rentalInboxes/gmail-ownedinbox"), { ownerUid: "outsider", updatedAt: now() }));
  await assertSucceeds(adminServices.completeRental({ rentalId: request.id, code: "123456", adminUser: admin }));
  assert.equal((await services.loadRentalCode(request.id)).code, "123456");
  await assertFails(sdk.getDoc(sdk.doc(database("outsider"), "rentalCodes", request.id)));
  await assertFails(sdk.getDocs(sdk.query(sdk.collection(buyer.db, "rentalCodes"), sdk.where("uid", "==", "buyer"))));
  await assertFails(sdk.getDocs(sdk.collection(a.db, "rentalCodes")));
  await seed({ "rentalCodes/expired": { uid: "buyer", rentalId: "expired", code: "123456", createdAt: sdk.Timestamp.now(), expiresAt: sdk.Timestamp.fromMillis(Date.now() - 1000) } });
  await assertFails(sdk.getDoc(sdk.doc(buyer.db, "rentalCodes/expired")));
  await assertFails(sdk.getDoc(sdk.doc(a.db, "rentalCodes/expired")));
  const next = await services.requestRental(values);
  await assertSucceeds(adminServices.assignRental({ rentalId: next.id, inbox: "owned.inbox+two@gmail.com", authorizedMailbox: true, adminUser: admin }));
  await assertSucceeds(adminServices.rejectServiceRequest("rentals", next.id, "No code arrived at the authorized inbox", admin));
  assert.equal((await sdk.getDoc(sdk.doc(buyer.db, "users/buyer"))).data().balance, 4950);
  await assert.rejects(adminServices.rejectServiceRequest("rentals", next.id, "Duplicate refund", admin), /Only pending/);
});

test("a profile-authorized administrator without an email claim records their UID as reviewer", async () => {
  await seed({ "users/uid-admin": { ...profile("uid-admin"), isAdmin: true } });
  const db = env.authenticatedContext("uid-admin", {}).firestore();
  await assertSucceeds(sdk.updateDoc(sdk.doc(db, "referrals/buyer"), {
    lifetimeRatePercent: 4.5, reviewedBy: "uid-admin", reviewedAt: now(), updatedAt: now()
  }));
  await assertFails(sdk.updateDoc(sdk.doc(db, "referrals/buyer"), {
    lifetimeRatePercent: 5, reviewedBy: "impersonated", reviewedAt: now(), updatedAt: now()
  }));
});
