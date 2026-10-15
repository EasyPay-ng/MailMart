// Marketplace: seller KYC, listings, orders and the fee model.
//
// Money does not move when an order is placed. Placing an order records it and
// raises a pending debit; an administrator settles that debit, which is the
// single point where the buyer is charged and the seller is paid. That mirrors
// the wallet, keeps every balance change behind an administrator, and means a
// bug in the ordering UI cannot move anyone's money.

import {
  auth,
  db,
  doc,
  getDoc,
  getDocs,
  collection,
  addDoc,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  runTransaction,
  writeBatch,
  arrayUnion
} from "./firebase.js";

import { formatNaira } from "./wallet.js";
import { resolveReferralCode, REFERRALS } from "./referrals.js";
import { installmentAmount, isFullyPaid, mayShip } from "./installments.js";
import { prepareLifetimeReferral } from "./referral-rewards.js";

export const LISTINGS = "listings";
export const ORDERS = "orders";
export const KYC = "kyc";
export const MAIL = "mail";
export const TRANSACTIONS = "transactions";

export const CATEGORIES = [
  "Phones & Tablets",
  "Computers & Laptops",
  "Electronics",
  "Fashion",
  "Beauty & Personal Care",
  "Home & Kitchen",
  "Building Materials",
  "Groceries",
  "Baby Products",
  "Sports & Outdoors",
  "Automobile",
  "Services",
  "Other"
];

export const ID_TYPES = [
  "National ID (NIN)",
  "Voter's Card",
  "Driver's Licence",
  "International Passport"
];

export const STATUS_LABEL = {
  pending_payment: "Awaiting payment",
  paid: "Paid",
  shipped: "Shipped",
  completed: "Completed",
  delivered_pending_balance: "Delivered · balance outstanding",
  cancelled: "Cancelled",
  refunded: "Refunded"
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
function requireUser() {
  const user = auth.currentUser;
  if (!user) throw new Error("You are not signed in.");
  return user;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function rows(snapshot) {
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function stamp(status, actor) {
  return { status, at: new Date().toISOString(), by: actor || "" };
}

/* ------------------------------------------------------------------ */
/* pricing — mirrored exactly by firestore.rules                       */
/* ------------------------------------------------------------------ */

/** A listing is discounted only when the discount is real and lower. */
export function hasDiscount(listing) {
  const discount = Number(listing?.discountPrice || 0);
  const price = Number(listing?.price || 0);
  return discount > 0 && discount < price;
}

export function unitPriceOf(listing) {
  return hasDiscount(listing) ? Number(listing.discountPrice) : Number(listing?.price || 0);
}

/** Sellers charge per state; the default applies where they set no override. */
export function deliveryFeeFor(listing, state) {
  const byState = listing?.deliveryByState || {};
  const override = byState[state];
  if (typeof override === "number" && Number.isFinite(override)) return override;
  return Number(listing?.deliveryDefault || 0);
}

export function quoteFor(listing, quantity, state, settings) {
  const unit = unitPriceOf(listing);
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  const subtotal = round2(unit * qty);
  const deliveryFee = round2(deliveryFeeFor(listing, state));
  // firestore.rules recomputes this quote and only accepts a stored fee that is
  // actually a number; an unset (or malformed) fee has to quote as zero here too.
  const serviceFee = round2(
    typeof settings?.serviceFee === "number" && Number.isFinite(settings.serviceFee)
      ? settings.serviceFee
      : 0
  );
  return {
    unitPrice: unit,
    quantity: qty,
    subtotal,
    deliveryFee,
    serviceFee,
    total: round2(subtotal + deliveryFee + serviceFee),
    // the platform keeps the service fee, so the seller gets item + delivery
    sellerPayout: round2(subtotal + deliveryFee)
  };
}

/* ------------------------------------------------------------------ */
/* seller KYC                                                          */
/* ------------------------------------------------------------------ */
export async function submitKyc(values) {
  const user = requireUser();
  await setDoc(
    doc(db, KYC, user.uid),
    {
      ...values,
      uid: user.uid,
      email: user.email || "",
      status: "pending",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export function watchMyKyc(onValue, onError = console.error) {
  const user = requireUser();
  return onSnapshot(
    doc(db, KYC, user.uid),
    (snap) => onValue(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError
  );
}

/** Administrator view of applications awaiting review. */
export function watchKycQueue(onRows, onError = console.error) {
  const q = query(collection(db, KYC), where("status", "==", "pending"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

export async function reviewKyc(application, approve, adminUser, reason = "") {
  const batch = writeBatch(db);
  batch.update(doc(db, KYC, application.uid), {
    status: approve ? "approved" : "rejected",
    rejectionReason: approve ? "" : reason,
    reviewedBy: adminUser.email || adminUser.uid,
    reviewedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  // isSeller is the flag the listing rules check; only an admin may set it.
  batch.update(doc(db, "users", application.uid), {
    isSeller: approve,
    updatedAt: serverTimestamp()
  });
  await batch.commit();
}

/* ------------------------------------------------------------------ */
/* listings                                                            */
/* ------------------------------------------------------------------ */
export function watchActiveListings(onRows, onError = console.error) {
  const q = query(collection(db, LISTINGS), where("status", "==", "active"), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

export function watchMyListings(onRows, onError = console.error) {
  const user = requireUser();
  const q = query(collection(db, LISTINGS), where("sellerUid", "==", user.uid), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

/** Every listing, including paused ones. Administrator only. */
export function watchAllListings(onRows, onError = console.error) {
  const q = query(collection(db, LISTINGS), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

export async function createListing(values) {
  const user = requireUser();
  return addDoc(collection(db, LISTINGS), {
    ...values,
    sellerUid: user.uid,
    sellerEmail: user.email || "",
    status: "active",
    soldCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export async function updateListing(id, values) {
  await updateDoc(doc(db, LISTINGS, id), { ...values, updatedAt: serverTimestamp() });
}

export async function setListingStatus(id, status) {
  await updateDoc(doc(db, LISTINGS, id), { status, updatedAt: serverTimestamp() });
}

/* ------------------------------------------------------------------ */
/* orders                                                              */
/* ------------------------------------------------------------------ */

/**
 * Record an order and raise the pending debit that pays for it.
 * Nothing is charged here — an administrator settles the debit.
 */
export async function placeOrder({ listing, quantity, address, settings, affiliateCode = "", paymentMode = "full" }) {
  const user = requireUser();
  const quote = quoteFor(listing, quantity, address.state, settings);
  if (!["full", "installment"].includes(paymentMode)) throw new Error("Choose a valid payment option.");
  if (paymentMode === "installment" && listing.installmentEnabled !== true) throw new Error("Instalments are not enabled for this item.");
  const installmentDelivery = listing.installmentDelivery === "after_first" ? "after_first" : "after_full";
  const dueNow = paymentMode === "installment" ? installmentAmount(quote.total, 1) : quote.total;
  if (paymentMode === "installment") installmentAmount(quote.sellerPayout, 1); // also require a payable seller share

  if (Number(listing.stock ?? 1) < 1) throw new Error("This item is out of stock.");
  if (!listing.sellerEmail) throw new Error("That listing has no seller attached.");
  if (listing.sellerUid === user.uid) throw new Error("You cannot buy your own listing.");
  const buyer = await getDoc(doc(db, "users", user.uid));
  if (!buyer.exists()) throw new Error("Finish setting up your profile on the dashboard before ordering.");
  const affiliate = await resolveReferralCode(affiliateCode);
  if (affiliate && !affiliate.affiliateActive) throw new Error("That affiliate is not active. Remove the code or use an active affiliate's code.");
  if (affiliate && [user.uid, listing.sellerUid].includes(affiliate.uid)) {
    throw new Error("An affiliate cannot earn commission on their own purchase or listing. Remove the code to continue.");
  }

  const orderRef = doc(collection(db, ORDERS));
  const txRef = paymentMode === "installment" ? doc(db, TRANSACTIONS, orderRef.id + "_month_1") : doc(collection(db, TRANSACTIONS));

  const batch = writeBatch(db);

  batch.set(orderRef, {
    listingId: listing.id,
    listingTitle: listing.title || "",
    listingImage: listing.image || "",
    buyerUid: user.uid,
    buyerEmail: user.email || "",
    sellerUid: listing.sellerUid || "",
    sellerEmail: listing.sellerEmail || "",
    referrerUid: buyer.data().referredBy || null,
    affiliateUid: affiliate?.uid || null,
    affiliateCode: affiliate?.code || "",
    paymentTxId: txRef.id,
    rewardsSettledAt: null,
    paymentMode, installmentMonths: paymentMode === "installment" ? 12 : 0, installmentDelivery,
    installmentsPaid: 0, totalPaid: 0, sellerPaid: 0, deliveredAt: null, fullyPaidAt: null,
    quantity: quote.quantity,
    itemPrice: quote.unitPrice,
    subtotal: quote.subtotal,
    deliveryFee: quote.deliveryFee,
    serviceFee: quote.serviceFee,
    total: quote.total,
    sellerPayout: quote.sellerPayout,
    status: "pending_payment",
    address: {
      name: address.name || "",
      phone: address.phone || "",
      state: address.state || "",
      lga: address.lga || "",
      street: address.street || ""
    },
    timeline: [stamp("pending_payment", user.email)],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  batch.set(txRef, {
    type: "order_payment",
    direction: "debit",
    status: "pending",
    uid: user.uid,
    email: user.email || "",
    amount: dueNow,
    installmentNumber: paymentMode === "installment" ? 1 : 0,
    orderId: orderRef.id,
    reference: listing.title || "Marketplace order",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  await batch.commit();

  // Tell the seller, via the Trigger Email extension. Failure here must not
  // undo a placed order, so it is deliberately not awaited upstream.
  await queueOrderEmail({ orderId: orderRef.id, listing, quote, address }).catch((err) => {
    console.error("Could not queue the seller notification:", err);
  });

  return orderRef.id;
}

/**
 * The Trigger Email extension watches `mail`. A client may only queue one
 * notice per order, addressed to that order's real seller — see the rules.
 */
async function queueOrderEmail({ orderId, listing, quote, address }) {
  if (!listing.sellerEmail) return;

  await addDoc(collection(db, MAIL), {
    to: listing.sellerEmail,
    orderId,
    message: {
      subject: `New order on MailMart: ${listing.title}`,
      html: [
        `<h2 style="margin:0 0 12px">You have a new order</h2>`,
        `<p><b>Item:</b> ${escapeHtml(listing.title)}</p>`,
        `<p><b>Quantity:</b> ${quote.quantity}</p>`,
        `<p><b>Item total:</b> ${formatNaira(quote.subtotal)}</p>`,
        `<p><b>Delivery:</b> ${formatNaira(quote.deliveryFee)}</p>`,
        `<p><b>You receive:</b> ${formatNaira(quote.sellerPayout)}</p>`,
        `<p><b>Ship to:</b> ${escapeHtml(address.name)} — ${escapeHtml(address.street)}, `,
        `${escapeHtml(address.lga)}, ${escapeHtml(address.state)}. `,
        `Phone ${escapeHtml(address.phone)}</p>`,
        `<p>The buyer's payment is being confirmed. Ship once the order shows as <b>Paid</b>.</p>`
      ].join("")
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function watchBuyerOrders(onRows, onError = console.error) {
  const user = requireUser();
  const q = query(collection(db, ORDERS), where("buyerUid", "==", user.uid), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

export function watchSellerOrders(onRows, onError = console.error) {
  const user = requireUser();
  const q = query(collection(db, ORDERS), where("sellerUid", "==", user.uid), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

/** Every order on the platform. Administrator only. */
export function watchAllOrders(onRows, onError = console.error) {
  const q = query(collection(db, ORDERS), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

const TRANSITIONS = {
  shipped: ["paid"],
  completed: ["shipped"],
  cancelled: ["pending_payment", "paid"]
};

/** Move an order along. The rules re-check who may make each transition. */
export async function advanceOrder(order, status, actor, cancellationReason = "") {
  await runTransaction(db, async (t) => {
    const orderRef = doc(db, ORDERS, order.id);
    const fresh = await t.get(orderRef);
    if (!fresh.exists()) throw new Error("That order no longer exists.");
    const current = fresh.data();
    const target = status === "completed" && current.paymentMode === "installment" && !isFullyPaid(current)
      ? "delivered_pending_balance" : status;
    const allowed = target === "delivered_pending_balance" ? ["shipped"] : (TRANSITIONS[target] || []);
    if (!allowed.includes(current.status)) throw new Error("That order cannot make this status change.");
    if (target === "shipped" && !mayShip(current)) throw new Error("This plan requires all 12 payments before delivery.");
    if (target === "cancelled" && (current.paidAt || current.totalPaid > 0)) throw new Error("A paid order must be refunded by an administrator, not simply cancelled.");
    let referralRef = null;
    let recordFirstPurchase = false;
    if (target === "completed" && current.referrerUid) {
      referralRef = doc(db, REFERRALS, current.buyerUid);
      const referral = await t.get(referralRef);
      if (!referral.exists() || referral.data().referrerUid !== current.referrerUid) throw new Error("The buyer's referral record is inconsistent.");
      recordFirstPurchase = !referral.data().firstCompletedOrderId;
    }
    const patch = { status: target, updatedAt: serverTimestamp(), timeline: arrayUnion(stamp(target, actor)) };
    if (["completed", "delivered_pending_balance"].includes(target)) patch.deliveredAt = serverTimestamp();
    if (target === "completed") patch.completedAt = serverTimestamp();
    if (target === "cancelled" && cancellationReason.trim()) patch.cancellationReason = cancellationReason.trim().slice(0, 500);
    t.update(orderRef, patch);
    if (recordFirstPurchase) t.update(referralRef, {
      firstCompletedOrderId: order.id, firstPurchaseCompletedAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
  });
}

/** Request only the next monthly debit; an administrator still settles it. */
export async function requestInstallmentPayment(orderId) {
  const user = requireUser();
  return runTransaction(db, async (t) => {
    const snap = await t.get(doc(db, ORDERS, orderId));
    if (!snap.exists()) throw new Error("That order no longer exists.");
    const order = snap.data();
    if (order.buyerUid !== user.uid || order.paymentMode !== "installment" || ["cancelled", "refunded"].includes(order.status)) throw new Error("This is not your active instalment plan.");
    const number = Number(order.installmentsPaid || 0) + 1;
    if (number > 12) throw new Error("This plan has been paid in full.");
    const ref = doc(db, TRANSACTIONS, orderId + "_month_" + number);
    const previous = await t.get(ref);
    const profile = await t.get(doc(db, "users", user.uid));
    if (previous.exists()) {
      if (previous.data().status === "pending") return { id: ref.id, pending: true };
      throw new Error("This monthly request needs an administrator's review before it can be retried.");
    }
    const amount = installmentAmount(order.total, number);
    if (!profile.exists() || profile.data().balance < amount) throw new Error("Top up your wallet for this month's payment first.");
    t.set(ref, { type: "order_payment", direction: "debit", status: "pending", uid: user.uid,
      email: user.email || "", amount, installmentNumber: number, orderId,
      reference: `${order.listingTitle || "Goods"} — instalment ${number}/12`,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return { id: ref.id, pending: true };
  });
}

export async function saveInstallmentTerms(listingId, enabled, delivery) {
  if (!["after_first", "after_full"].includes(delivery)) throw new Error("Choose the delivery rule.");
  await updateDoc(doc(db, LISTINGS, listingId), { installmentEnabled: enabled === true,
    installmentDelivery: delivery, updatedAt: serverTimestamp() });
}

/* ------------------------------------------------------------------ */
/* settlement — administrator only                                     */
/* ------------------------------------------------------------------ */

/**
 * Charge the buyer and pay the seller in one atomic step.
 *
 * The service fee is simply not paid out: the buyer is charged the full total
 * and the seller receives subtotal + delivery, so the difference stays with
 * the platform.
 *
 * The buyer's pending order_payment row — raised when the order was placed —
 * is completed in the same transaction, and the seller's credit is written to
 * the ledger as an order_payout row. Before this, settlement moved balances
 * but left the ledger untouched: the buyer's wallet history never mentioned
 * the purchase, and the pending payment row sat there forever.
 */
export async function settleOrderPayment(order, adminUser, paymentId = "") {
  let legacyPaymentRef = null;
  if (!paymentId && !order.paymentTxId) {
    const matches = await getDocs(query(collection(db, TRANSACTIONS), where("orderId", "==", order.id), where("type", "==", "order_payment")));
    if (matches.size !== 1) throw new Error("This order must have exactly one matching payment request.");
    legacyPaymentRef = matches.docs[0].ref;
  }
  await runTransaction(db, async (t) => {
    const orderRef = doc(db, ORDERS, order.id);
    const orderSnap = await t.get(orderRef);
    if (!orderSnap.exists()) throw new Error("That order no longer exists.");
    const data = orderSnap.data();
    const plan = data.paymentMode === "installment";
    if (["cancelled", "refunded", "completed"].includes(data.status) || (!plan && data.status !== "pending_payment") || (plan && data.installmentsPaid >= 12)) {
      throw new Error(`This order is already ${STATUS_LABEL[data.status] || data.status} or fully paid.`);
    }
    if (data.buyerUid === data.sellerUid) throw new Error("A buyer cannot pay themselves.");
    const number = plan ? Number(data.installmentsPaid || 0) + 1 : 0;
    const selectedId = paymentId || (plan && number > 1 ? order.id + "_month_" + number : data.paymentTxId);
    const paymentRef = selectedId ? doc(db, TRANSACTIONS, selectedId) : legacyPaymentRef;
    if (!paymentRef) throw new Error("The payment request is missing.");
    const buyerRef = doc(db, "users", data.buyerUid);
    const sellerRef = doc(db, "users", data.sellerUid);
    const buyer = await t.get(buyerRef);
    const seller = await t.get(sellerRef);
    const paymentSnap = await t.get(paymentRef);
    if (!buyer.exists() || !seller.exists()) throw new Error("The buyer or seller account is missing.");
    const payment = paymentSnap.exists() ? paymentSnap.data() : null;
    const due = plan ? installmentAmount(data.total, number) : Number(data.total);
    const payout = plan ? installmentAmount(data.sellerPayout, number) : Number(data.sellerPayout);
    if (!payment || payment.type !== "order_payment" || payment.status !== "pending" || payment.uid !== data.buyerUid ||
        payment.orderId !== order.id || payment.amount !== due || (plan && payment.installmentNumber !== number)) throw new Error("The payment request does not match the next unpaid amount.");
    if (![due, payout, buyer.data().balance, seller.data().balance].every(Number.isFinite) || due <= 0 || payout <= 0) throw new Error("The order contains an invalid money amount.");
    if (buyer.data().balance < due) throw new Error(`The buyer needs ${formatNaira(due)} for this payment.`);
    const nextBuyer = round2(buyer.data().balance - due);
    const nextSeller = round2(seller.data().balance + payout);
    const reviewer = adminUser?.email || adminUser?.uid;
    if (!reviewer) throw new Error("Administrator identity is missing.");
    const payoutId = "order_payout_" + order.id + (plan ? "_" + number : "");
    const buyerLifetime = await prepareLifetimeReferral(t, { uid: data.buyerUid, profile: buyer.data(), sourceId: paymentRef.id,
      type: "order_payment", amount: due, adminUser });
    const sellerLifetime = await prepareLifetimeReferral(t, { uid: data.sellerUid, profile: seller.data(), sourceId: payoutId,
      type: "order_payout", amount: payout, adminUser });
    const finalPayment = !plan || number === 12;
    const finishDeliveredPlan = finalPayment && !!data.deliveredAt;
    let referralRef = null;
    let markFirst = false;
    if (finishDeliveredPlan && data.referrerUid) {
      referralRef = doc(db, REFERRALS, data.buyerUid);
      const referral = await t.get(referralRef);
      if (!referral.exists()) throw new Error("The referral record is missing.");
      markFirst = !referral.data().firstCompletedOrderId;
    }
    t.update(buyerRef, { balance: nextBuyer, updatedAt: serverTimestamp() });
    t.update(sellerRef, { balance: nextSeller, updatedAt: serverTimestamp() });
    t.update(paymentRef, { status: "completed", balanceAfter: nextBuyer, reviewedBy: reviewer,
      reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    t.set(doc(db, TRANSACTIONS, payoutId), { type: "order_payout", direction: "credit", status: "completed",
      uid: data.sellerUid, email: data.sellerEmail || "", orderId: order.id, installmentNumber: number,
      amount: payout, reference: data.listingTitle || "Marketplace order", balanceAfter: nextSeller,
      reviewedBy: reviewer, reviewedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    const status = finishDeliveredPlan ? "completed" : (data.status === "pending_payment" ? "paid" : data.status);
    const patch = { status, totalPaid: round2(Number(data.totalPaid || 0) + due), sellerPaid: round2(Number(data.sellerPaid || 0) + payout),
      installmentsPaid: plan ? number : 0, updatedAt: serverTimestamp(), timeline: arrayUnion(stamp(plan ? `instalment_${number}_paid` : "paid", reviewer)) };
    if (!data.paidAt) patch.paidAt = serverTimestamp();
    if (finalPayment) patch.fullyPaidAt = serverTimestamp();
    if (finishDeliveredPlan) patch.completedAt = serverTimestamp();
    t.update(orderRef, patch);
    if (markFirst) t.update(referralRef, { firstCompletedOrderId: order.id, firstPurchaseCompletedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    buyerLifetime(); sellerLifetime();
  });
}

/** Return a paid order's money to the buyer. Administrator only. */
export async function refundOrder(order, adminUser) {
  await runTransaction(db, async (t) => {
    const snap = await t.get(doc(db, ORDERS, order.id));
    if (!snap.exists()) throw new Error("That order no longer exists.");
    const data = snap.data();
    if (!["paid", "shipped", "delivered_pending_balance"].includes(data.status)) {
      throw new Error(`An order that is ${STATUS_LABEL[data.status] || data.status} cannot be refunded.`);
    }

    const refundRef = doc(db, TRANSACTIONS, "order_refund_" + order.id);
    const previous = await t.get(refundRef);
    if (previous.exists()) throw new Error("This refund has already been recorded.");
    const buyerRef = doc(db, "users", data.buyerUid);
    const buyerSnap = await t.get(buyerRef);
    if (!buyerSnap.exists()) throw new Error("The buyer account is missing.");

    const refundAmount = data.paymentMode === "installment" ? Number(data.totalPaid || 0) : Number(data.total || 0);
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error("There is no paid amount to refund.");
    const refunded = round2(Number(buyerSnap.data().balance || 0) + refundAmount);
    t.update(buyerRef, { balance: refunded, updatedAt: serverTimestamp() });

    // The refund is its own ledger row, not an edit of history: the purchase
    // stays on the buyer's record and the refund sits next to it.
    t.set(refundRef, {
      type: "order_refund",
      orderId: order.id,
      direction: "credit",
      status: "completed",
      uid: data.buyerUid,
      email: data.buyerEmail || "",
      amount: refundAmount,
      reference: data.listingTitle || "Marketplace order",
      balanceAfter: refunded,
      reviewedBy: adminUser?.email || adminUser?.uid || "",
      reviewedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    t.update(doc(db, ORDERS, order.id), {
      status: "refunded",
      refundedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      timeline: arrayUnion(stamp("refunded", adminUser.email))
    });
  });
}
