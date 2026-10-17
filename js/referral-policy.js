// The agreed referral policy. All amounts are naira, never foreign currency.
// These values are also enforced by firestore.rules for referral ledger rows.
export const REFERRAL_AMOUNTS = Object.freeze({
  emailSale: 200,
  purchaseReferrer: 500,
  purchaseBuyer: 200,
  affiliateRate: 0.05
});

export const REWARD_TYPES = Object.freeze([
  "email_referral", "purchase_referral", "purchase_welcome", "affiliate_commission", "lifetime_commission"
]);

// Use the entire, case-sensitive Firebase uid. Truncating/uppercasing it can
// give two different accounts the same code.
export function referralCodeFor(uid) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(uid || ""))) {
    throw new Error("This account does not have a valid referral ID.");
  }
  return "MM-" + uid;
}

export function normalizeReferralCode(code) {
  const value = String(code || "").trim();
  if (!value) return "";
  if (!/^MM-[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Enter a valid MailMart code. Codes are case-sensitive.");
  }
  return value;
}

export function roundMoney(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("The money amount is invalid.");
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function affiliateCommissionFor(subtotal, rate = REFERRAL_AMOUNTS.affiliateRate) {
  const amount = roundMoney(subtotal);
  const selectedRate = Number(rate);
  if (amount < 0) throw new Error("The goods subtotal cannot be negative.");
  if (!Number.isFinite(selectedRate) || selectedRate < 0 || selectedRate > 1) throw new Error("Affiliate rate must be between 0% and 100%.");
  return roundMoney(amount * selectedRate);
}

/** A plan, not a payment. Only an administrator can commit these credits. */
export function orderRewardPlan(order, referral = null) {
  const installmentCount = Number(order.installmentCount || order.installmentMonths || 12);
  if (order.status !== "completed" || !order.paidAt || (order.paymentMode === "installment" && (order.installmentsPaid !== installmentCount || roundMoney(order.totalPaid) !== roundMoney(order.total)))) {
    throw new Error("Rewards require a paid order with confirmed delivery.");
  }
  if (order.buyerUid === order.sellerUid) {
    throw new Error("Self-purchases do not qualify for rewards.");
  }
  const rewards = [];
  if (referral && !referral.purchaseOrderId &&
      (!referral.firstCompletedOrderId || referral.firstCompletedOrderId === order.id)) {
    if (referral.refereeUid !== order.buyerUid ||
        referral.referrerUid !== order.referrerUid ||
        referral.referrerUid === order.buyerUid) {
      throw new Error("The order's referral attribution is inconsistent.");
    }
    rewards.push({
      id: "purchase_referral_" + order.buyerUid,
      type: "purchase_referral", uid: referral.referrerUid,
      amount: REFERRAL_AMOUNTS.purchaseReferrer,
      reference: "First referred goods purchase"
    }, {
      id: "purchase_welcome_" + order.buyerUid,
      type: "purchase_welcome", uid: order.buyerUid,
      amount: REFERRAL_AMOUNTS.purchaseBuyer,
      reference: "Your first completed referred purchase"
    });
  }
  if (order.affiliateUid) {
    if ([order.buyerUid, order.sellerUid].includes(order.affiliateUid)) {
      throw new Error("An affiliate cannot earn commission on their own purchase or listing.");
    }
    const ratePercent = Number(order.affiliateRatePercent ?? REFERRAL_AMOUNTS.affiliateRate * 100);
    if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100) throw new Error("The affiliate rate on this order is invalid.");
    const amount = affiliateCommissionFor(order.subtotal, ratePercent / 100);
    if (amount > 0) rewards.push({
      id: "affiliate_" + order.id,
      type: "affiliate_commission", uid: order.affiliateUid, amount,
      reference: `${ratePercent}% goods commission — ` + (order.listingTitle || "Marketplace order")
    });
  }
  return rewards;
}

// Only real platform earnings and spending. Never rewards-on-rewards, cash
// deposits/withdrawals, refunds or arbitrary administrator wallet credits.
export const LIFETIME_SOURCE_TYPES = Object.freeze([
  "email_payout", "order_payment", "order_payout", "social_sale", "social_purchase", "rental_payment"
]);
export function lifetimeCommissionFor(amount, ratePercent) {
  const rate = Number(ratePercent);
  if (!Number.isFinite(rate) || rate < 4 || rate > 5) throw new Error("Lifetime commission must be between 4% and 5%.");
  const base = roundMoney(amount);
  if (base < 0) throw new Error("Commission cannot be based on a negative amount.");
  return roundMoney(base * rate / 100);
}
