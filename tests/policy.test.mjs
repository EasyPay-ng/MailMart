import test from "node:test";
import assert from "node:assert/strict";
import {
  REFERRAL_AMOUNTS, referralCodeFor, normalizeReferralCode, affiliateCommissionFor, orderRewardPlan
} from "../js/referral-policy.js";
import { order, referral } from "./helpers/firebase-mock.mjs";

test("agreed amounts and collision-free case-sensitive codes", () => {
  assert.deepEqual(REFERRAL_AMOUNTS, { emailSale: 200, purchaseReferrer: 500, purchaseBuyer: 200, affiliateRate: 0.15 });
  assert.notEqual(referralCodeFor("AbcdefghOne"), referralCodeFor("abcdefghTwo"));
  assert.equal(normalizeReferralCode(" MM-AbC123 "), "MM-AbC123");
  assert.throws(() => normalizeReferralCode("MM-../users"));
  assert.throws(() => referralCodeFor(""));
});
test("15% is rounded to kobo and excludes all delivery/service fees", () => {
  assert.equal(affiliateCommissionFor(1000), 150);
  assert.equal(affiliateCommissionFor(99.99), 15);
  assert.equal(affiliateCommissionFor(123.45), 18.52);
  assert.equal(affiliateCommissionFor(0), 0);
  for (const value of [NaN, Infinity, -1, "100"]) assert.throws(() => affiliateCommissionFor(value));
  const plan = orderRewardPlan(order(), referral("buyer", "referrer", { firstCompletedOrderId: "one" }));
  assert.deepEqual(plan.map((r) => r.amount), [500, 200, 150]);
});
test("no fixed bonus on repeats or later orders, but affiliate commission remains per sale", () => {
  assert.equal(orderRewardPlan(order(), referral("buyer", "referrer", { purchaseOrderId: "older" })).length, 1);
  assert.equal(orderRewardPlan(order(), referral("buyer", "referrer", { firstCompletedOrderId: "older" })).length, 1);
  assert.deepEqual(orderRewardPlan(order("one", { affiliateUid: null }), null), []);
});
test("unpaid, cancelled, refunded, undelivered and self-dealing orders never qualify", () => {
  for (const status of ["pending_payment", "paid", "shipped", "cancelled", "refunded"]) {
    assert.throws(() => orderRewardPlan(order("one", { status })));
  }
  assert.throws(() => orderRewardPlan(order("one", { paidAt: null })));
  assert.throws(() => orderRewardPlan(order("one", { sellerUid: "buyer" })));
  for (const affiliateUid of ["buyer", "seller"]) assert.throws(() => orderRewardPlan(order("one", { affiliateUid })));
  assert.throws(() => orderRewardPlan(order(), referral("someone-else")));
});
