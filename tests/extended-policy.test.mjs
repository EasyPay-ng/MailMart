import test from "node:test";
import assert from "node:assert/strict";
import { lifetimeCommissionFor, LIFETIME_SOURCE_TYPES, orderRewardPlan } from "../js/referral-policy.js";
import { installmentAmount, installmentQuote, installmentSchedule, monthlyDueDate, mayShip, isFullyPaid } from "../js/installments.js";
import { order, referral } from "./helpers/firebase-mock.mjs";

test("lifetime rates are 4–5%, kobo-rounded, and source types never include recursive rewards or cash transfers", () => {
  assert.equal(lifetimeCommissionFor(1000, 4), 40);
  assert.equal(lifetimeCommissionFor(1000, 5), 50);
  assert.equal(lifetimeCommissionFor(123.45, 4.5), 5.56);
  for (const rate of [3.99, 5.01, NaN, Infinity]) assert.throws(() => lifetimeCommissionFor(100, rate));
  assert.throws(() => lifetimeCommissionFor(-1, 4));
  assert.throws(() => lifetimeCommissionFor(Infinity, 4));
  for (const type of ["deposit", "withdrawal", "order_refund", "rental_refund", "admin_credit", "email_referral", "purchase_referral", "purchase_welcome", "affiliate_commission", "lifetime_commission"]) assert.ok(!LIFETIME_SOURCE_TYPES.includes(type), type);
  for (const type of ["email_payout", "order_payment", "order_payout", "social_sale", "social_purchase", "rental_payment"]) assert.ok(LIFETIME_SOURCE_TYPES.includes(type), type);
});

test("twelve zero-interest payments sum to exactly the total, even at awkward kobo values", () => {
  for (const total of [0.12, 1, 100.01, 1350, 12345.67, 999999.99]) {
    const cents = Array.from({ length: 12 }, (_, i) => Math.round(installmentAmount(total, i + 1) * 100));
    assert.equal(cents.reduce((a, b) => a + b, 0), Math.round(total * 100));
    assert.ok(cents.every((value) => value > 0));
    assert.equal(new Set(cents.slice(0, 11)).size, 1);
    assert.ok(cents[11] - cents[0] <= 11); // at most eleven kobo of rounding
  }
  assert.equal(installmentQuote(100.01).interest, 0);
  assert.equal(installmentQuote(100.01).months, 12);
  for (const number of [0, 13, 1.5, NaN]) assert.throws(() => installmentAmount(100, number));
  for (const total of [0, -1, 0.11, Infinity, NaN]) assert.throws(() => installmentAmount(total, 1));
});

test("monthly due dates are calendar-month anchored, including month end and leap years", () => {
  assert.equal(monthlyDueDate(new Date("2028-01-31T10:15:00Z"), 1).toISOString(), "2028-02-29T10:15:00.000Z");
  assert.equal(monthlyDueDate(new Date("2028-01-31T10:15:00Z"), 2).toISOString(), "2028-03-31T10:15:00.000Z");
  assert.equal(monthlyDueDate(new Date("2027-01-31T10:15:00Z"), 1).toISOString(), "2027-02-28T10:15:00.000Z");
  const schedule = installmentSchedule({ total: 1200, paidAt: new Date("2026-10-15T12:00:00Z"), installmentsPaid: 2 });
  assert.equal(schedule.length, 12);
  assert.equal(schedule[11].dueAt.toISOString(), "2027-09-15T12:00:00.000Z");
  assert.equal(schedule.filter((row) => row.paid).length, 2);
});

test("all installment delivery waits for full payment, including legacy after-first plans", () => {
  const partial = order("one", { paymentMode: "installment", installmentsPaid: 1, totalPaid: 112.5, status: "paid", installmentDelivery: "after_full" });
  assert.equal(mayShip(partial), false);
  assert.equal(mayShip({ ...partial, installmentDelivery: "after_first" }), false);
  assert.equal(isFullyPaid(partial), false);
  assert.throws(() => orderRewardPlan({ ...partial, status: "completed" }, referral()), /paid order/);
  const full = { ...partial, installmentsPaid: 12, totalPaid: 1350 };
  assert.equal(isFullyPaid(full), true); assert.equal(mayShip(full), true);
  assert.equal(isFullyPaid({ ...full, totalPaid: 1349.99 }), false);
});
