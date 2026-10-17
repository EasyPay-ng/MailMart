import test from "node:test";
import assert from "node:assert/strict";
import { createApp, admin, profile, referral, order } from "./helpers/firebase-mock.mjs";

function seed(extra = {}) {
  return {
    "users/buyer": profile("buyer", 5000, "referrer"), "users/seller": profile("seller", 200),
    "users/referrer": profile("referrer", 100), "users/affiliate": profile("affiliate", 50),
    "referrals/buyer": referral("buyer", "referrer", { firstCompletedOrderId: "one", firstPurchaseCompletedAt: 6 }),
    "orders/one": order(), ...extra
  };
}
const user = (uid) => ({ uid, email: uid + "@example.com", displayName: uid });

test("registration atomically records attribution and a code, but pays NOTHING", async () => {
  const app = await createApp({ "referralCodes/MM-referrer": { uid: "referrer", affiliateActive: false } });
  const refs = await app.load("js/referrals.js");
  refs.rememberRegistrationReferral("MM-referrer");
  refs.bindRegistrationReferral(user("new-user"));
  const accounts = await app.load("js/account.js");
  const result = await accounts.ensureUserProfile(user("new-user"), { isAffiliate: true });
  assert.equal(result.created, true);
  assert.equal(app.data("users/new-user").balance, 0);
  assert.equal(app.data("users/new-user").referredBy, "referrer");
  assert.equal(app.data("users/new-user").isAffiliate, undefined);
  assert.equal(app.data("referrals/new-user").purchaseOrderId, null);
  assert.equal(app.data("referralCodes/MM-new-user").affiliateActive, false);
  assert.equal(Object.keys(app.all()).filter((key) => key.startsWith("transactions/")).length, 0);
  refs.rememberRegistrationReferral("MM-referrer"); refs.bindRegistrationReferral(user("new-user"));
  assert.equal((await accounts.ensureUserProfile(user("new-user"))).created, false);
});

test("failed registration profile write retains UID-bound attribution for repair, not another user", async () => {
  const app = await createApp({ "referralCodes/MM-referrer": { uid: "referrer", affiliateActive: false } });
  const refs = await app.load("js/referrals.js");
  const accounts = await app.load("js/account.js");
  refs.rememberRegistrationReferral("MM-referrer"); refs.bindRegistrationReferral(user("new-user"));
  app.failOn("referrals/new-user");
  await assert.rejects(accounts.ensureUserProfile(user("new-user")), /refusal/);
  assert.equal(app.data("users/new-user"), undefined);
  assert.equal(app.data("referralCodes/MM-new-user"), undefined);
  app.failOn(null);
  await accounts.ensureUserProfile(user("another-user"));
  assert.equal(app.data("users/another-user").referredBy, null);
  await accounts.ensureUserProfile(user("new-user"));
  assert.equal(app.data("users/new-user").referredBy, "referrer");
});

test("existing users cannot switch inviter; legacy users can obtain a code without profile rewrites", async () => {
  const app = await createApp({ "users/buyer": profile("buyer", 5000, "original"),
    "referralCodes/MM-referrer": { uid: "referrer", affiliateActive: false } });
  const refs = await app.load("js/referrals.js");
  refs.rememberRegistrationReferral("MM-referrer"); refs.bindRegistrationReferral(user("buyer"));
  const accounts = await app.load("js/account.js");
  await accounts.ensureUserProfile(user("buyer"));
  await refs.ensureReferralCode(user("buyer"));
  assert.equal(app.data("users/buyer").referredBy, "original");
  assert.equal(app.data("users/buyer").balance, 5000);
  assert.equal(app.data("referralCodes/MM-buyer").uid, "buyer");
});

test("invitation links keep the GitHub Pages subpath and affiliate return cannot redirect off-site", async () => {
  const app = await createApp({}, { url: "https://example.com/MailMart/marketplace.html?aff=MM-referrer&item=item-1" });
  const refs = await app.load("js/referrals.js");
  assert.equal(refs.referralLink("MM-referrer"), "https://example.com/MailMart/register.html?ref=MM-referrer");
  assert.equal(refs.affiliateLink("MM-referrer", "item-1"), "https://example.com/MailMart/marketplace.html?aff=MM-referrer&item=item-1");
  assert.equal(refs.captureAffiliateVisit(), "MM-referrer");
  refs.rememberMarketplaceReturn();
  assert.equal(refs.takeMarketplaceReturn(), "marketplace.html?aff=MM-referrer&item=item-1");
  assert.equal(refs.takeMarketplaceReturn(), "");
  app.storage.set("mailmart.marketplaceReturn", "https://evil.example");
  assert.equal(refs.takeMarketplaceReturn(), "");
});

test("email payout credits the seller plus exactly one ₦200 referrer reward across concurrent sales", async () => {
  const app = await createApp(seed({
    "referrals/buyer": referral(), "sales/s1": { uid: "buyer", email: "sold1@example.com", status: "approved" },
    "sales/s2": { uid: "buyer", email: "sold2@example.com", status: "approved" }
  }));
  const wallet = await app.load("js/wallet.js");
  await Promise.all(["s1", "s2"].map((id) => wallet.payEmailSale({ sale: { id, uid: "buyer" }, amount: 1000, adminUser: admin })));
  assert.equal(app.data("users/buyer").balance, 7000);
  assert.equal(app.data("users/referrer").balance, 300);
  assert.equal(app.data("transactions/email_referral_buyer").amount, 200);
  assert.ok(["s1", "s2"].includes(app.data("referrals/buyer").emailSaleId));
  assert.ok(app.stats.retries >= 1);
  await assert.rejects(wallet.payEmailSale({ sale: { id: "s1", uid: "buyer" }, amount: 1000, adminUser: admin }), /Approve/);
});

test("fresh sale approval is required; a denied referral write rolls back the seller's payout too", async () => {
  for (const status of ["pending", "rejected", "paid"]) {
    const app = await createApp(seed({ "sales/s1": { uid: "buyer", status } }));
    const wallet = await app.load("js/wallet.js");
    await assert.rejects(wallet.payEmailSale({ sale: { id: "s1", uid: "buyer", status: "approved" }, amount: 100, adminUser: admin }));
    assert.equal(app.data("users/buyer").balance, 5000);
  }
  const app = await createApp(seed({ "sales/s1": { uid: "buyer", status: "approved" } }));
  app.failOn("transactions/email_referral_buyer");
  const wallet = await app.load("js/wallet.js");
  await assert.rejects(wallet.payEmailSale({ sale: { id: "s1", uid: "buyer" }, amount: 1000, adminUser: admin }));
  assert.equal(app.data("sales/s1").status, "approved");
  assert.equal(app.data("users/buyer").balance, 5000);
  assert.equal(app.data("users/referrer").balance, 100);
  assert.equal(app.data("referrals/buyer").emailSaleId, null);
});

test("delivery records the first purchase under concurrency without moving funds", async () => {
  const app = await createApp(seed({
    "referrals/buyer": referral(),
    "orders/one": order("one", { status: "shipped" }), "orders/two": order("two", { status: "shipped" })
  }));
  const market = await app.load("js/marketplace.js");
  await Promise.all(["one", "two"].map((id) => market.advanceOrder({ id }, "completed", "buyer@example.com")));
  assert.ok(["one", "two"].includes(app.data("referrals/buyer").firstCompletedOrderId));
  assert.equal(app.data("users/buyer").balance, 5000);
  assert.equal(app.data("users/referrer").balance, 100);
  assert.equal(app.data("orders/two").status, "completed");
  assert.equal(Object.keys(app.all()).filter((key) => key.startsWith("transactions/")).length, 0);
});

test("completed purchase pays ₦500 to referrer, ₦200 to buyer and the 5% default goods commission to affiliate", async () => {
  const app = await createApp(seed());
  const refs = await app.load("js/referrals.js");
  const result = await refs.settleOrderRewards("one", admin);
  assert.equal(result.total, 750);
  assert.equal(app.data("users/referrer").balance, 600);
  assert.equal(app.data("users/buyer").balance, 5200);
  assert.equal(app.data("users/affiliate").balance, 100);
  assert.equal(app.data("users/seller").balance, 200);
  assert.equal(app.data("transactions/affiliate_one").amount, 50); // NOT 5% of 1350
  assert.equal(app.data("transactions/purchase_referral_buyer").balanceAfter, 600);
  assert.equal(app.data("referrals/buyer").purchaseOrderId, "one");
  await assert.rejects(refs.settleOrderRewards("one", admin), /already been reviewed/);
});

test("referrer may also be affiliate: accumulate both credits and preserve running ledger balances", async () => {
  const app = await createApp(seed({ "orders/one": order("one", { affiliateUid: "referrer", affiliateCode: "MM-referrer" }) }));
  const refs = await app.load("js/referrals.js");
  await refs.settleOrderRewards("one", admin);
  assert.equal(app.data("users/referrer").balance, 650);
  assert.equal(app.data("transactions/purchase_referral_buyer").balanceAfter, 600);
  assert.equal(app.data("transactions/affiliate_one").balanceAfter, 650);
});

test("reviewing a later order first cannot consume first-purchase bonus; repeat purchases only earn commission", async () => {
  const app = await createApp(seed({ "orders/two": order("two") }));
  const refs = await app.load("js/referrals.js");
  assert.equal((await refs.settleOrderRewards("two", admin)).total, 50);
  assert.equal(app.data("referrals/buyer").purchaseOrderId, null);
  assert.equal((await refs.settleOrderRewards("one", admin)).total, 750);
  assert.equal(app.data("users/referrer").balance, 600);
  assert.equal(app.data("users/buyer").balance, 5200);
  assert.equal(app.data("users/affiliate").balance, 150);
});

test("concurrent reward release pays only once and conflicts are retried", async () => {
  const app = await createApp(seed());
  const refs = await app.load("js/referrals.js");
  const attempts = await Promise.allSettled([refs.settleOrderRewards("one", admin), refs.settleOrderRewards("one", admin)]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(app.data("users/referrer").balance, 600);
  assert.equal(app.data("users/affiliate").balance, 100);
  assert.ok(app.stats.retries >= 1);
});

test("failed reward commit rolls back all balances, ledger rows and milestone markers", async () => {
  const app = await createApp(seed());
  app.failOn("transactions/affiliate_one");
  const before = app.all();
  const refs = await app.load("js/referrals.js");
  await assert.rejects(refs.settleOrderRewards("one", admin), /refusal/);
  assert.deepEqual(app.all(), before);
});

test("rewards refuse unpaid, undelivered and refunded source events and incomplete referral records", async () => {
  for (const extra of [{ status: "paid" }, { status: "cancelled" }, { status: "refunded" }, { paidAt: null }]) {
    const app = await createApp(seed({ "orders/one": order("one", extra) }));
    const refs = await app.load("js/referrals.js");
    await assert.rejects(refs.settleOrderRewards("one", admin));
    assert.equal(app.data("users/buyer").balance, 5000);
  }
  const app = await createApp(seed({ "referrals/buyer": referral() }));
  const refs = await app.load("js/referrals.js");
  await assert.rejects(refs.settleOrderRewards("one", admin), /not been recorded/);
});

test("order payment uses document-only reads before writes and completes its pending debit atomically", async () => {
  const pending = order("one", { status: "pending_payment", paidAt: null });
  const app = await createApp(seed({ "orders/one": pending,
    "transactions/payment-one": { type: "order_payment", status: "pending", amount: 1350, uid: "buyer", orderId: "one" }
  }));
  const market = await app.load("js/marketplace.js");
  await market.settleOrderPayment(pending, admin);
  assert.equal(app.data("users/buyer").balance, 3650);
  assert.equal(app.data("users/seller").balance, 1500);
  assert.equal(app.data("transactions/payment-one").status, "completed");
  assert.equal(app.data("orders/one").status, "paid");
  assert.equal(app.data("users/referrer").balance, 100); // no reward before delivery
  await assert.rejects(market.settleOrderPayment(pending, admin), /already/);
});

test("legacy order payment query is resolved outside the transaction; mismatched debit is refused", async () => {
  for (const amount of [1350, 1]) {
    const pending = order("one", { status: "pending_payment", paidAt: null, paymentTxId: undefined });
    const app = await createApp(seed({ "orders/one": pending,
      "transactions/legacy": { type: "order_payment", status: "pending", amount, uid: "buyer", orderId: "one" }
    }));
    const market = await app.load("js/marketplace.js");
    if (amount === 1350) await market.settleOrderPayment(pending, admin);
    else await assert.rejects(market.settleOrderPayment(pending, admin), /does not match/);
    assert.equal(app.data("users/buyer").balance, amount === 1350 ? 3650 : 5000);
  }
});

test("checkout snapshots active affiliate and registration referrer without changing price or moving money", async () => {
  const app = await createApp(seed({ "referralCodes/MM-affiliate": { uid: "affiliate", affiliateActive: true } }), { user: user("buyer") });
  const market = await app.load("js/marketplace.js");
  const id = await market.placeOrder({ listing: { id: "listing", title: "Goods", price: 2000, discountPrice: 1000,
    stock: 1, sellerUid: "seller", sellerEmail: "seller@example.com", deliveryDefault: 300 },
    quantity: 1, address: { state: "Delta" }, settings: { serviceFee: 50 }, affiliateCode: "MM-affiliate" });
  assert.equal(app.data("orders/" + id).subtotal, 1000);
  assert.equal(app.data("orders/" + id).total, 1350);
  assert.equal(app.data("orders/" + id).affiliateUid, "affiliate");
  assert.equal(app.data("orders/" + id).referrerUid, "referrer");
  assert.equal(app.data("users/buyer").balance, 5000);
  assert.ok(app.data("orders/" + id).paymentTxId);
});

test("checkout rejects inactive, self-purchase and self-listing affiliate codes", async () => {
  for (const affiliateUid of ["inactive", "buyer", "seller"]) {
    const app = await createApp(seed({ ["referralCodes/MM-" + affiliateUid]: { uid: affiliateUid, affiliateActive: affiliateUid !== "inactive" } }), { user: user("buyer") });
    const market = await app.load("js/marketplace.js");
    await assert.rejects(market.placeOrder({ listing: { id: "listing", price: 1000, stock: 1,
      sellerUid: "seller", sellerEmail: "seller@example.com" }, quantity: 1, address: {},
      affiliateCode: "MM-" + affiliateUid }));
  }
});

test("affiliate applications require verified email and approval; applicants cannot self-activate", async () => {
  let verified = false;
  const fakeUser = { ...user("buyer"), get emailVerified() { return verified; }, reload: async () => {}, getIdToken: async () => "token" };
  const app = await createApp(seed({ "referralCodes/MM-buyer": { uid: "buyer", affiliateActive: false } }), { user: fakeUser });
  const refs = await app.load("js/referrals.js");
  const values = { promotionPlan: "I will share with my community.", acceptedTerms: true };
  await assert.rejects(refs.applyForAffiliate(values), /Verify/);
  verified = true;
  await refs.applyForAffiliate(values);
  assert.equal(app.data("affiliateApplications/buyer").status, "pending");
  assert.equal(app.data("referralCodes/MM-buyer").affiliateActive, false);
  await assert.rejects(refs.applyForAffiliate(values), /already/);
  await refs.reviewAffiliate("buyer", "approved", admin);
  assert.equal(app.data("referralCodes/MM-buyer").affiliateActive, true);
  await refs.reviewAffiliate("buyer", "suspended", admin, "Review requested");
  assert.equal(app.data("referralCodes/MM-buyer").affiliateActive, false);
});
