import test from "node:test";
import assert from "node:assert/strict";
import { createApp, admin, profile, referral, order } from "./helpers/firebase-mock.mjs";
const user = (uid, emailVerified = true) => ({ uid, email: uid + "@example.com", emailVerified, reload: async () => {}, getIdToken: async () => "token" });
function seed(extra = {}) {
  return { "users/buyer": profile("buyer", 5000, "referrer"), "users/seller": profile("seller", 200),
    "users/referrer": profile("referrer", 100), "users/affiliate": profile("affiliate", 50),
    "referrals/buyer": referral(), ...extra };
}
const sale = { id: "s1", uid: "buyer" };
const payout = (wallet, id = "s1", amount = 1000) => wallet.payEmailSale({ sale: { ...sale, id }, amount, adminUser: admin });
const review = (rewards, values = {}) => rewards.reviewReferral({ refereeUid: "buyer", status: "approved", ratePercent: 4, adminUser: admin, ...values });

test("verification is not approval and never clears a fraud flag; review is audited without moving money", async () => {
  const app = await createApp(seed({ "referrals/buyer": referral("buyer", "referrer", { status: "unverified", verifiedAt: null }) }));
  const rewards = await app.load("js/referral-rewards.js");
  await assert.rejects(review(rewards), /verify/);
  await rewards.syncReferralVerification(user("buyer", false));
  assert.equal(app.data("referrals/buyer").status, "unverified");
  await rewards.syncReferralVerification(user("buyer"));
  assert.equal(app.data("referrals/buyer").status, "pending");
  await review(rewards, { status: "flagged", reason: "Needs duplicate-account review", riskReason: "duplicate", privateNote: "Private evidence" });
  await rewards.syncReferralVerification(user("buyer"));
  assert.equal(app.data("referrals/buyer").status, "flagged");
  await assert.rejects(review(rewards, { ratePercent: 5.01 }), /4% and 5%/);
  await assert.rejects(review(rewards, { status: "rejected", reason: "" }), /reason/);
  assert.equal(app.data("referrals/buyer").privateNote, undefined);
  const audit = Object.entries(app.all()).find(([key]) => key.startsWith("referralAudit/"))[1];
  assert.equal(audit.privateNote, "Private evidence");
  assert.equal(app.data("users/referrer").balance, 100);
  await review(rewards, { ratePercent: 4.5 });
  assert.equal(app.data("referrals/buyer").lifetimeRatePercent, 4.5);
});

test("email verification can be recorded after an early pending/flagged admin review without unflagging", async () => {
  for (const status of ["pending", "flagged", "rejected"]) {
    const app = await createApp(seed({ "referrals/buyer": referral("buyer", "referrer", { status, verifiedAt: null }) }));
    const rewards = await app.load("js/referral-rewards.js");
    await rewards.syncReferralVerification(user("buyer"));
    assert.equal(app.data("referrals/buyer").status, status);
    assert.ok(app.data("referrals/buyer").verifiedAt);
  }
});

test("pending referral does not block email earnings: fixed and lifetime claims are held, then released once", async () => {
  const app = await createApp(seed({ "referrals/buyer": referral("buyer", "referrer", { status: "pending" }), "sales/s1": { uid: "buyer", status: "approved" } }));
  const wallet = await app.load("js/wallet.js"), rewards = await app.load("js/referral-rewards.js");
  await payout(wallet);
  assert.equal(app.data("users/buyer").balance, 6000); assert.equal(app.data("users/referrer").balance, 100);
  assert.equal(app.data("referrals/buyer").firstPaidEmailSaleId, "s1");
  assert.equal(app.data("referralClaims/email_referral_buyer").amount, 200);
  assert.equal(app.data("referralClaims/lifetime_email_payout_s1").amount, 40);
  await assert.rejects(rewards.releaseReferralClaim("email_referral_buyer", admin), /Approve/);
  await review(rewards);
  await rewards.releaseReferralClaim("email_referral_buyer", admin);
  const attempts = await Promise.allSettled([rewards.releaseReferralClaim("lifetime_email_payout_s1", admin), rewards.releaseReferralClaim("lifetime_email_payout_s1", admin)]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(app.data("users/referrer").balance, 340);
  assert.equal(app.data("transactions/lifetime_email_payout_s1").status, "completed");
  await assert.rejects(payout(wallet), /Approve/);
  assert.equal(Object.keys(app.all()).filter((key) => key.startsWith("referralClaims/lifetime_lifetime_")).length, 0);
});

test("lifetime rate is a snapshot, future admin changes do not reprice already earned claims", async () => {
  const app = await createApp(seed({ "sales/s1": { uid: "buyer", status: "approved" }, "sales/s2": { uid: "buyer", status: "approved" } }));
  const wallet = await app.load("js/wallet.js"), rewards = await app.load("js/referral-rewards.js");
  await payout(wallet);
  await review(rewards, { ratePercent: 5 });
  await payout(wallet, "s2");
  assert.equal(app.data("referralClaims/lifetime_email_payout_s1").amount, 40);
  assert.equal(app.data("referralClaims/lifetime_email_payout_s2").amount, 50);
  await rewards.releaseReferralClaim("lifetime_email_payout_s1", admin);
  await rewards.releaseReferralClaim("lifetime_email_payout_s2", admin);
  assert.equal(app.data("users/referrer").balance, 390); // 100 + fixed200 +40+50
});

test("flagged/rejected activity accrues no new rewards; existing held claims remain blocked", async () => {
  const app = await createApp(seed({ "sales/s1": { uid: "buyer", status: "approved" }, "sales/s2": { uid: "buyer", status: "approved" } }));
  const wallet = await app.load("js/wallet.js"), rewards = await app.load("js/referral-rewards.js");
  await payout(wallet);
  await review(rewards, { status: "flagged", reason: "Bot activity", riskReason: "bot" });
  await payout(wallet, "s2");
  assert.equal(app.data("users/buyer").balance, 7000);
  assert.equal(app.data("referralClaims/lifetime_email_payout_s2"), undefined);
  await assert.rejects(rewards.releaseReferralClaim("lifetime_email_payout_s1", admin), /Approve/);
  await rewards.rejectReferralClaim("lifetime_email_payout_s1", "Ineligible activity", admin);
  await review(rewards);
  await assert.rejects(rewards.releaseReferralClaim("lifetime_email_payout_s1", admin), /not pending/);
});

test("first purchase holds paired bonuses but pays unrelated affiliate; release and rollback remain atomic", async () => {
  const app = await createApp(seed({ "orders/one": order(), "referrals/buyer": referral("buyer", "referrer", { status: "pending", firstCompletedOrderId: "one" }) }));
  const refs = await app.load("js/referrals.js"), rewards = await app.load("js/referral-rewards.js");
  const result = await refs.settleOrderRewards("one", admin);
  assert.equal(result.total, 50); assert.equal(result.held.length, 2);
  assert.equal(app.data("users/affiliate").balance, 100); assert.equal(app.data("users/buyer").balance, 5000);
  await review(rewards);
  app.failOn("transactions/purchase_welcome_buyer");
  const before = app.all();
  await assert.rejects(rewards.releaseReferralClaim("purchase_referral_buyer", admin), /refusal/);
  assert.deepEqual(app.all(), before);
  app.failOn(null);
  const released = await rewards.releaseReferralClaim("purchase_welcome_buyer", admin);
  assert.equal(released.total, 700);
  assert.equal(app.data("users/referrer").balance, 600); assert.equal(app.data("users/buyer").balance, 5200);
  await assert.rejects(rewards.releaseReferralClaim("purchase_referral_buyer", admin), /not pending/);
});

test("rejecting either first-purchase claim rejects the whole pair without a wallet movement", async () => {
  const app = await createApp(seed({ "orders/one": order(), "referrals/buyer": referral("buyer", "referrer", { status: "pending", firstCompletedOrderId: "one" }) }));
  await (await app.load("js/referrals.js")).settleOrderRewards("one", admin);
  const rewards = await app.load("js/referral-rewards.js");
  await rewards.rejectReferralClaim("purchase_welcome_buyer", "Duplicate household/self-dealing evidence", admin);
  assert.equal(app.data("referralClaims/purchase_welcome_buyer").status, "rejected");
  assert.equal(app.data("referralClaims/purchase_referral_buyer").status, "rejected");
  assert.equal(app.data("users/buyer").balance, 5000);
});

test("lifetime commissions follow both real spending and earnings, and wait for paid delivery", async () => {
  const pending = order("one", { status: "pending_payment", paidAt: null, completedAt: null });
  const app = await createApp(seed({ "users/seller": profile("seller", 200, "referrer"),
    "referrals/seller": referral("seller", "referrer", { lifetimeRatePercent: 5 }), "orders/one": pending,
    "transactions/payment-one": { type: "order_payment", status: "pending", amount: 1350, uid: "buyer", orderId: "one" } }));
  const market = await app.load("js/marketplace.js"), rewards = await app.load("js/referral-rewards.js");
  await market.settleOrderPayment(pending, admin);
  assert.equal(app.data("referralClaims/lifetime_payment-one").amount, 54);
  assert.equal(app.data("referralClaims/lifetime_order_payout_one").amount, 65);
  await assert.rejects(rewards.releaseReferralClaim("lifetime_payment-one", admin), /fulfilment/);
  await market.advanceOrder({ id: "one" }, "shipped", "seller@example.com");
  await market.advanceOrder({ id: "one" }, "completed", "buyer@example.com");
  await rewards.releaseReferralClaim("lifetime_payment-one", admin);
  await rewards.releaseReferralClaim("lifetime_order_payout_one", admin);
  assert.equal(app.data("users/referrer").balance, 219);
});

test("a refused lifetime-claim write rolls back email earnings and fixed rewards together", async () => {
  const app = await createApp(seed({ "sales/s1": { uid: "buyer", status: "approved" } }));
  const wallet = await app.load("js/wallet.js");
  app.failOn("referralClaims/lifetime_email_payout_s1");
  const before = app.all(); await assert.rejects(payout(wallet), /refusal/); assert.deepEqual(app.all(), before);
});
