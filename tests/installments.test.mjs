import test from "node:test";
import assert from "node:assert/strict";
import { createApp, admin, profile, referral, order } from "./helpers/firebase-mock.mjs";
import { installmentAmount } from "../js/installments.js";
const buyer = { uid: "buyer", email: "buyer@example.com" };
function seed(delivery = "after_full", extra = {}) {
  return { "users/buyer": profile("buyer", 5000, "referrer"), "users/seller": profile("seller", 200),
    "users/referrer": profile("referrer", 100), "users/affiliate": profile("affiliate", 0), "referrals/buyer": referral(),
    "orders/plan": order("plan", { status: "pending_payment", paidAt: null, completedAt: null, deliveredAt: null,
      fullyPaidAt: null, paymentMode: "installment", installmentMonths: 12, installmentDelivery: delivery,
      installmentsPaid: 0, totalPaid: 0, sellerPaid: 0, fulfillmentMode: "seller", paymentTxId: "plan_month_1" }),
    "orders/plan/deliveryProof/proof": { uid: "seller", email: "seller@example.com", fulfillmentMode: "seller", photo: "p".repeat(300), signature: "s".repeat(150), recipientName: "Buyer Name", note: "", createdAt: 1 },
    "transactions/plan_month_1": { type: "order_payment", direction: "debit", status: "pending", uid: "buyer", amount: 112.5, orderId: "plan", installmentNumber: 1 }, ...extra };
}
async function month(app, market, n) {
  if (n > 1) await market.requestInstallmentPayment("plan");
  await market.settleOrderPayment({ id: "plan", paymentTxId: "plan_month_1" }, admin, "plan_month_" + n);
}

test("checkout snapshots seller-configured weekly terms, blocks unverified warehouse stock, and saves the selected variation", async () => {
  const app = await createApp(seed(), { user: buyer }); const market = await app.load("js/marketplace.js");
  const input = { listing: { id: "item", title: "Goods", price: 1000, stock: 2, variants: ["Blue", "Black"], sellerUid: "seller", sellerEmail: "seller@example.com", deliveryDefault: 300,
      installmentEnabled: true, installmentUnit: "week", installmentCount: 4, installmentMonths: 0, installmentDelivery: "after_full", warehouseRequired: true, warehouseVerified: false },
    quantity: 1, address: { state: "Delta" }, settings: { serviceFee: 50 }, paymentMode: "installment", selectedVariant: "Black" };
  await assert.rejects(market.placeOrder({ ...input, listing: { ...input.listing, installmentEnabled: false } }), /not enabled/);
  await assert.rejects(market.placeOrder(input), /warehouse yet/);
  await assert.rejects(market.placeOrder({ ...input, selectedVariant: "Green", listing: { ...input.listing, warehouseVerified: true } }), /valid product variation/);
  await assert.rejects(market.placeOrder({ ...input, listing: { ...input.listing, price: 0.01, deliveryDefault: 0, warehouseVerified: true }, settings: { serviceFee: 0 } }), /too small/);
  const id = await market.placeOrder({ ...input, listing: { ...input.listing, warehouseVerified: true } });
  const placed = app.data("orders/" + id);
  assert.equal(placed.installmentDelivery, "after_full"); assert.equal(placed.installmentCount, 4); assert.equal(placed.installmentUnit, "week");
  assert.equal(placed.installmentMonths, 0); assert.equal(placed.selectedVariant, "Black");
  assert.equal(placed.total, 1350); assert.equal(placed.totalPaid, 0);
  assert.equal(app.data("transactions/" + placed.paymentTxId).amount, 337.5);
  assert.equal(app.data("users/buyer").balance, 5000);
});

test("first monthly payment pays only its funded seller share and duplicate/concurrent confirms cannot double-charge", async () => {
  const app = await createApp(seed(), { user: buyer }); const market = await app.load("js/marketplace.js");
  const attempts = await Promise.allSettled([month(app, market, 1), month(app, market, 1)]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(app.data("users/buyer").balance, 4887.5);
  assert.equal(app.data("users/seller").balance, 308.33);
  assert.equal(app.data("orders/plan").installmentsPaid, 1);
  assert.equal(app.data("orders/plan").totalPaid, 112.5);
  assert.equal(app.data("transactions/order_payout_plan_1").amount, 108.33);
  assert.ok(!app.data("transactions/order_payout_plan"));
});

test("twelve monthly payments total exactly the order price and seller payout, with a single next-month request", async () => {
  const app = await createApp(seed(), { user: buyer }); const market = await app.load("js/marketplace.js");
  await month(app, market, 1);
  const requests = await Promise.all([market.requestInstallmentPayment("plan"), market.requestInstallmentPayment("plan")]);
  assert.equal(requests[0].id, requests[1].id);
  for (let n = 2; n <= 12; n++) await month(app, market, n);
  assert.equal(app.data("orders/plan").totalPaid, 1350); assert.equal(app.data("orders/plan").sellerPaid, 1300);
  assert.equal(app.data("users/buyer").balance, 3650); assert.equal(app.data("users/seller").balance, 1500);
  assert.equal(app.data("transactions/order_payout_plan_12").amount, 108.37);
  const payments = Object.entries(app.all()).filter(([key, value]) => key.startsWith("transactions/") && value.type === "order_payment");
  assert.equal(payments.length, 12); assert.ok(payments.every(([, value]) => value.status === "completed"));
  await assert.rejects(market.requestInstallmentPayment("plan"), /paid in full/);
  await assert.rejects(month(app, market, 12), /paid in full/);
});

test("after-full delivery cannot ship early; fully paid delivery unlocks the first-purchase milestone", async () => {
  const app = await createApp(seed(), { user: buyer }); const market = await app.load("js/marketplace.js");
  await month(app, market, 1);
  await assert.rejects(market.advanceOrder({ id: "plan" }, "shipped", "seller"), /fully paid/);
  for (let n = 2; n <= 12; n++) await month(app, market, n);
  assert.equal(app.data("orders/plan").status, "paid");
  await market.advanceOrder({ id: "plan" }, "shipped", "seller");
  await market.advanceOrder({ id: "plan" }, "completed", "buyer");
  assert.equal(app.data("orders/plan").status, "completed");
  assert.equal(app.data("referrals/buyer").firstCompletedOrderId, "plan");
});

test("legacy after-first terms cannot bypass full-payment delivery; rewards unlock only after completed delivery", async () => {
  const app = await createApp(seed("after_first"), { user: buyer });
  const market = await app.load("js/marketplace.js"), refs = await app.load("js/referrals.js"), rewards = await app.load("js/referral-rewards.js");
  await month(app, market, 1);
  await assert.rejects(market.advanceOrder({ id: "plan" }, "shipped", "seller"), /fully paid/);
  assert.equal(app.data("orders/plan").status, "paid");
  assert.equal(app.data("referrals/buyer").firstCompletedOrderId, null);
  await assert.rejects(refs.settleOrderRewards("plan", admin), /paid, delivered/);
  await assert.rejects(rewards.releaseReferralClaim("lifetime_plan_month_1", admin), /fulfilment/);
  for (let n = 2; n <= 12; n++) await month(app, market, n);
  await market.advanceOrder({ id: "plan" }, "shipped", "seller");
  await market.advanceOrder({ id: "plan" }, "completed", "buyer");
  assert.equal(app.data("orders/plan").status, "completed");
  assert.equal(app.data("referrals/buyer").firstCompletedOrderId, "plan");
  await rewards.releaseReferralClaim("lifetime_plan_month_1", admin);
  assert.equal(app.data("users/referrer").balance, 104.5);
  await refs.settleOrderRewards("plan", admin);
  assert.equal(app.data("users/referrer").balance, 604.5); assert.equal(app.data("users/buyer").balance, 3850);
});

test("partial-plan refund returns only actual payments, blocks future debits/rewards, and never silently claws back seller money", async () => {
  const app = await createApp(seed("after_first"), { user: buyer });
  const market = await app.load("js/marketplace.js"), rewards = await app.load("js/referral-rewards.js");
  await month(app, market, 1); await month(app, market, 2);
  await assert.rejects(market.advanceOrder({ id: "plan" }, "cancelled", "buyer"), /refunded/);
  await market.refundOrder({ id: "plan" }, admin);
  assert.equal(app.data("transactions/order_refund_plan").amount, 225);
  assert.equal(app.data("users/buyer").balance, 5000);
  assert.equal(app.data("users/seller").balance, 416.66); // existing platform-funded refund policy
  await assert.rejects(market.refundOrder({ id: "plan" }, admin), /cannot be refunded/);
  await assert.rejects(market.requestInstallmentPayment("plan"), /active instalment/);
  await assert.rejects(rewards.releaseReferralClaim("lifetime_plan_month_1", admin), /fulfilment/);
});

test("skipped-month, wrong-price, insufficient-balance and denied commits never move money", async () => {
  for (const change of [{ amount: 1 }, { installmentNumber: 2 }]) {
    const values = seed(); values["transactions/plan_month_1"] = { ...values["transactions/plan_month_1"], ...change };
    const app = await createApp(values, { user: buyer }); const market = await app.load("js/marketplace.js");
    const before = app.all(); await assert.rejects(month(app, market, 1), /does not match/); assert.deepEqual(app.all(), before);
  }
  const app = await createApp(seed("after_first", { "users/buyer": profile("buyer", 100, "referrer") }), { user: buyer });
  const market = await app.load("js/marketplace.js");
  await assert.rejects(month(app, market, 1), /buyer needs/);
  const other = await createApp(seed(), { user: buyer }); const otherMarket = await other.load("js/marketplace.js");
  other.failOn("transactions/order_payout_plan_1"); const before = other.all();
  await assert.rejects(month(other, otherMarket, 1), /refusal/); assert.deepEqual(other.all(), before);
  assert.equal(installmentAmount(1350, 1), 112.5);
});
