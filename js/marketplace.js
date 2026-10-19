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
  const sellerSaleFeePercent = Number.isFinite(Number(settings?.sellerSaleFeePercent))
    ? Math.max(0, Math.min(100, Number(settings.sellerSaleFeePercent))) : 0;
  const sellerSaleFee = round2(subtotal * sellerSaleFeePercent / 100);
  return {
    unitPrice: unit,
    quantity: qty,
    subtotal,
    deliveryFee,
    serviceFee,
    sellerSaleFeePercent,
    sellerSaleFee,
    total: round2(subtotal + deliveryFee + serviceFee),
    sellerPayout: round2(subtotal + deliveryFee - sellerSaleFee)
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

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const millis = new Date(value || 0).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

function newestListingFirst(a, b) {
  const difference = timestampMillis(b.createdAt) - timestampMillis(a.createdAt);
  // Firestore uses the document ID as its final ordering tie-breaker.
  return difference || String(b.id).localeCompare(String(a.id));
}

export function watchMyListings(onRows, onError = console.error) {
  const user = requireUser();
  const indexedQuery = query(
    collection(db, LISTINGS),
    where("sellerUid", "==", user.uid),
    orderBy("createdAt", "desc")
  );

  let unsubscribe;
  unsubscribe = onSnapshot(indexedQuery, (snap) => onRows(rows(snap)), (error) => {
    const code = String(error?.code || "").replace(/^firestore\//, "");
    if (code !== "failed-precondition") {
      onError(error);
      return;
    }

    /* A seller only reads their own (normally small) set of listings. If the
       composite index has not reached Firebase yet, use Firestore's automatic
       sellerUid field index and retain the same newest-first presentation in
       the browser. This keeps Sell usable while an index is being built. */
    console.warn("The seller listings composite index is unavailable; using the indexed fallback.", error);
    const fallbackQuery = query(
      collection(db, LISTINGS),
      where("sellerUid", "==", user.uid)
    );
    unsubscribe = onSnapshot(
      fallbackQuery,
      (snap) => onRows(rows(snap).sort(newestListingFirst)),
      onError
    );
  });

  return () => {
    if (unsubscribe) unsubscribe();
  };
}

/** Every listing, including paused ones. Administrator only. */
export function watchAllListings(onRows, onError = console.error) {
  const q = query(collection(db, LISTINGS), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

export async function createListing(values, { skipFee = false } = {}) {
  const user = requireUser();
  const listingRef = doc(collection(db, LISTINGS));
  const userRef = doc(db, "users", user.uid);
  const settingsRef = doc(db, "settings", "platform");
  const listingData = {
    ...values, sellerUid: user.uid, sellerEmail: user.email || "", status: "active", soldCount: 0,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  };
  await runTransaction(db, async (t) => {
    let fee = 0;
    let profile = null;
    if (!skipFee) {
      const [settingsSnap, profileSnap] = await Promise.all([t.get(settingsRef), t.get(userRef)]);
      fee = Number(settingsSnap.exists() ? settingsSnap.data().listingFee || 0 : 0);
      if (!Number.isFinite(fee) || fee < 0) throw new Error("The current listing fee is invalid. Contact MailMart support.");
      profile = profileSnap;
      if (!profile.exists()) throw new Error("Your MailMart wallet profile is missing.");
      if (fee > 0) {
        const currentBalance = Number(profile.data().balance || 0);
        if (!Number.isFinite(currentBalance) || currentBalance < fee) throw new Error(`Your wallet needs ${formatNaira(fee)} to post this listing.`);
        const feeRef = doc(db, TRANSACTIONS, "listing_fee_" + listingRef.id);
        const previousFee = await t.get(feeRef);
        if (previousFee.exists()) throw new Error("A fee record already exists for this listing.");
        const balanceAfter = round2(currentBalance - fee);
        const now = serverTimestamp();
        t.update(userRef, { balance: balanceAfter, updatedAt: now, lastListingFeeId: listingRef.id });
        t.set(feeRef, { type: "listing_fee", direction: "debit", status: "completed", uid: user.uid,
          email: user.email || "", amount: fee, listingId: listingRef.id, balanceAfter,
          reference: `Listing fee · ${String(values.title || "New listing").slice(0, 120)}`,
          reviewedBy: user.email || user.uid, reviewedAt: now, createdAt: now, updatedAt: now });
      }
    }
    listingData.listingFeePaid = fee;
    t.set(listingRef, listingData);
  });
  return listingRef;
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
export async function placeOrder({ listing, quantity, address, settings, affiliateCode = "", paymentMode = "full", selectedVariant = "" }) {
  const user = requireUser();
  const quote = quoteFor(listing, quantity, address.state, settings);
  if (!["full", "installment"].includes(paymentMode)) throw new Error("Choose a valid payment option.");
  if (paymentMode === "installment" && listing.installmentEnabled !== true) throw new Error("Instalments are not enabled for this item.");
  if (paymentMode === "installment" && listing.warehouseRequired && listing.warehouseVerified !== true) throw new Error("MailMart has not verified this product at the warehouse yet.");
  const installmentUnit = listing.installmentUnit === "week" ? "week" : "month";
  const installmentCount = paymentMode === "installment"
    ? Math.floor(Number(listing.installmentCount || listing.installmentMonths || 12)) : 0;
  if (paymentMode === "installment" && !(installmentUnit === "week" ? installmentCount >= 1 && installmentCount <= 35 : installmentCount >= 1 && installmentCount <= 12)) {
    throw new Error("The seller has not configured a valid installment period.");
  }
  if (selectedVariant && !(Array.isArray(listing.variants) && listing.variants.some((variant) => (typeof variant === "string" ? variant : variant?.value || variant?.label) === selectedVariant))) {
    throw new Error("Choose a valid product variation.");
  }
  const installmentDelivery = "after_full";
  const dueNow = paymentMode === "installment" ? installmentAmount(quote.total, 1, installmentCount) : quote.total;
  if (paymentMode === "installment") installmentAmount(quote.sellerPayout, 1, installmentCount); // also require a payable seller share

  if (Number(listing.stock ?? 1) < 1) throw new Error("This item is out of stock.");
  if (!listing.sellerEmail) throw new Error("That listing has no seller attached.");
  if (listing.sellerUid === user.uid) throw new Error("You cannot buy your own listing.");
  const buyer = await getDoc(doc(db, "users", user.uid));
  if (!buyer.exists()) throw new Error("Finish setting up your profile on the dashboard before ordering.");
  const affiliate = await resolveReferralCode(affiliateCode);
  if (affiliate && !affiliate.affiliateActive) throw new Error("That affiliate is not active. Remove the code or use an active affiliate's code.");
  const categoryAffiliateRate = settings?.affiliateRatesByCategory?.[listing.category] ?? 5;
  const affiliateRatePercent = affiliate ? Number(listing.affiliateRatePercent ?? categoryAffiliateRate) : 0;
  if (!Number.isFinite(affiliateRatePercent) || affiliateRatePercent < 0 || affiliateRatePercent > 100) throw new Error("The affiliate commission rate is invalid.");
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
    selectedVariant: String(selectedVariant || "").slice(0, 120),
    buyerUid: user.uid,
    buyerEmail: user.email || "",
    sellerUid: listing.sellerUid || "",
    sellerEmail: listing.sellerEmail || "",
    referrerUid: buyer.data().referredBy || null,
    affiliateUid: affiliate?.uid || null,
    affiliateCode: affiliate?.code || "",
    affiliateRatePercent,
    fulfillmentMode: listing.fulfillmentMode === "mailmart" ? "mailmart" : "seller",
    deliveryEtaDays: Math.max(1, Math.min(90, Math.floor(Number(listing.deliveryEtaDays) || 3))),
    paymentTxId: txRef.id,
    rewardsSettledAt: null,
    paymentMode, installmentMonths: paymentMode === "installment" && installmentUnit === "month" ? installmentCount : 0,
    installmentCount, installmentUnit, installmentDelivery, installmentMissedCount: 0,
    installmentsPaid: 0, totalPaid: 0, sellerPaid: 0, deliveredAt: null, fullyPaidAt: null,
    quantity: quote.quantity,
    itemPrice: quote.unitPrice,
    subtotal: quote.subtotal,
    deliveryFee: quote.deliveryFee,
    serviceFee: quote.serviceFee,
    sellerSaleFeePercent: quote.sellerSaleFeePercent,
    sellerSaleFee: quote.sellerSaleFee,
    total: quote.total,
    sellerPayout: quote.sellerPayout,
    status: "pending_payment",
    stockReserved: false,
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
  await queueOrderEmail({ orderId: orderRef.id, listing, quote, address, selectedVariant }).catch((err) => {
    console.error("Could not queue the seller notification:", err);
  });

  return orderRef.id;
}

/**
 * The Trigger Email extension watches `mail`. A client may only queue one
 * notice per order, addressed to that order's real seller — see the rules.
 */
async function queueOrderEmail({ orderId, listing, quote, address, selectedVariant = "" }) {
  if (!listing.sellerEmail) return;

  await addDoc(collection(db, MAIL), {
    to: listing.sellerEmail,
    orderId,
    message: {
      subject: `New order on MailMart: ${listing.title}`,
      html: [
        `<h2 style="margin:0 0 12px">You have a new order</h2>`,
        `<p><b>Item:</b> ${escapeHtml(listing.title)}${selectedVariant ? ` · ${escapeHtml(selectedVariant)}` : ""}</p>`,
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

export function watchOrderMessages(orderId, onRows, onError = console.error) {
  requireUser();
  const q = query(collection(db, ORDERS, orderId, "messages"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

export async function sendOrderMessage(orderId, text) {
  const user = requireUser();
  const message = String(text || "").trim();
  if (!message || message.length > 1000) throw new Error("Write a message between 1 and 1,000 characters.");
  return addDoc(collection(db, ORDERS, orderId, "messages"), {
    uid: user.uid, email: user.email || "", text: message,
    createdAt: serverTimestamp()
  });
}

export function watchOrderDeliveryProof(orderId, onValue, onError = console.error) {
  requireUser();
  return onSnapshot(doc(db, ORDERS, orderId, "deliveryProof", "proof"), (snap) => onValue(snap.exists() ? snap.data() : null), onError);
}

export async function getOrderDeliveryProof(orderId) {
  requireUser();
  const snap = await getDoc(doc(db, ORDERS, orderId, "deliveryProof", "proof"));
  return snap.exists() ? snap.data() : null;
}

export async function saveOrderDeliveryProof(orderId, { photo, signature, recipientName, note = "" }) {
  const user = requireUser();
  const orderSnap = await getDoc(doc(db, ORDERS, orderId));
  if (!orderSnap.exists()) throw new Error("That order no longer exists.");
  const order = orderSnap.data();
  const sellerDelivery = order.fulfillmentMode !== "mailmart" && order.sellerUid === user.uid;
  if (!sellerDelivery && order.fulfillmentMode !== "mailmart") throw new Error("Only the seller can upload this order’s delivery proof.");
  if (order.status !== "paid" || !isFullyPaid(order)) throw new Error("Delivery proof is available after full payment is confirmed.");
  if (typeof photo !== "string" || photo.length < 100 || photo.length >= 500000) throw new Error("Add a compressed delivery photo under 500 KB.");
  if (typeof signature !== "string" || signature.length < 100 || signature.length >= 180000) throw new Error("Capture the recipient’s signature before submitting.");
  const name = String(recipientName || "").trim();
  if (name.length < 2 || name.length > 120) throw new Error("Enter the recipient’s full name.");
  const detail = String(note || "").trim().slice(0, 500);
  await setDoc(doc(db, ORDERS, orderId, "deliveryProof", "proof"), {
    uid: user.uid, email: user.email || "", fulfillmentMode: order.fulfillmentMode === "mailmart" ? "mailmart" : "seller",
    photo, signature, recipientName: name, note: detail, createdAt: serverTimestamp()
  });
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
    const target = status;
    const allowed = TRANSITIONS[target] || [];
    if (!allowed.includes(current.status)) throw new Error("That order cannot make this status change.");
    if (["shipped", "completed"].includes(target) && current.paymentMode === "installment" && !isFullyPaid(current)) throw new Error("This installment order must be fully paid before delivery.");
    if (target === "shipped" && !mayShip(current)) throw new Error("This order must be fully paid before delivery.");
    if (target === "shipped") {
      const cancellationSnap = await t.get(doc(db, "cancellationRequests", order.id));
      if (cancellationSnap.exists() && ["pending", "approved"].includes(cancellationSnap.data().status)) throw new Error("Dispatch is paused while the buyer’s cancellation request is reviewed.");
      const proof = await t.get(doc(db, ORDERS, order.id, "deliveryProof", "proof"));
      if (!proof.exists()) throw new Error("Upload the delivery photo and recipient signature before marking this order as shipped.");
    }
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

/** Request only the next scheduled installment; an administrator still settles it. */
export async function requestInstallmentPayment(orderId) {
  const user = requireUser();
  return runTransaction(db, async (t) => {
    const snap = await t.get(doc(db, ORDERS, orderId));
    if (!snap.exists()) throw new Error("That order no longer exists.");
    const order = snap.data();
    if (order.buyerUid !== user.uid || order.paymentMode !== "installment" || ["cancelled", "refunded"].includes(order.status)) throw new Error("This is not your active instalment plan.");
    const cancellationSnap = await t.get(doc(db, "cancellationRequests", orderId));
    if (cancellationSnap.exists() && ["pending", "approved"].includes(cancellationSnap.data().status)) throw new Error("Installment payments are paused while the cancellation request is reviewed.");
    const count = Math.floor(Number(order.installmentCount || order.installmentMonths || 12));
    const number = Number(order.installmentsPaid || 0) + 1;
    if (number > count) throw new Error("This plan has been paid in full.");
    const ref = doc(db, TRANSACTIONS, orderId + "_month_" + number);
    const previous = await t.get(ref);
    const profile = await t.get(doc(db, "users", user.uid));
    if (previous.exists()) {
      if (previous.data().status === "pending") return { id: ref.id, pending: true };
      throw new Error("This installment request needs an administrator's review before it can be retried.");
    }
    const amount = installmentAmount(order.total, number, count);
    if (!profile.exists() || profile.data().balance < amount) throw new Error("Top up your wallet for the next installment first.");
    t.set(ref, { type: "order_payment", direction: "debit", status: "pending", uid: user.uid,
      email: user.email || "", amount, installmentNumber: number, orderId,
      reference: `${order.listingTitle || "Goods"} — instalment ${number}/${count}`,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return { id: ref.id, pending: true };
  });
}

export async function saveInstallmentTerms(listingId, enabled, unit = "month", count = 12) {
  const normalizedUnit = unit === "week" ? "week" : "month";
  const number = Math.floor(Number(count));
  if (!(normalizedUnit === "week" ? number >= 1 && number <= 35 : number >= 1 && number <= 12)) throw new Error("Choose a valid installment duration.");
  const warehouseRequired = normalizedUnit === "week" ? number > 3 : number > 2;
  await updateDoc(doc(db, LISTINGS, listingId), {
    installmentEnabled: enabled === true,
    installmentUnit: normalizedUnit,
    installmentCount: enabled ? number : 0,
    installmentMonths: enabled && normalizedUnit === "month" ? number : 0,
    installmentDelivery: "after_full",
    warehouseRequired: enabled && warehouseRequired,
    updatedAt: serverTimestamp()
  });
}

export async function setWarehouseVerified(listingId, received) {
  await updateDoc(doc(db, LISTINGS, listingId), { warehouseVerified: received === true, updatedAt: serverTimestamp() });
}

export async function setListingAffiliateRate(listingId, ratePercent) {
  const rate = Number(ratePercent);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error("Affiliate rate must be between 0% and 100%.");
  await updateDoc(doc(db, LISTINGS, listingId), { affiliateRatePercent: Math.round(rate * 100) / 100, updatedAt: serverTimestamp() });
}

export function watchMyPromotionRequests(onRows, onError = console.error) {
  const user = requireUser();
  const q = query(collection(db, "promotionRequests"), where("uid", "==", user.uid), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}
export function watchAllPromotionRequests(onRows, onError = console.error) {
  const q = query(collection(db, "promotionRequests"), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}
export async function requestListingPromotion(listing, kind, settings) {
  const user = requireUser();
  if (!["hotDeal", "featured"].includes(kind)) throw new Error("Choose Hot Deals or Featured placement.");
  if (listing.sellerUid !== user.uid || listing.status !== "active") throw new Error("Only the owner of a live listing can promote it.");
  const fee = Number(kind === "featured" ? settings?.featuredFee : settings?.hotDealFee);
  if (!Number.isFinite(fee) || fee <= 0) throw new Error("This placement is not priced yet. Contact MailMart support.");
  const profile = await getDoc(doc(db, "users", user.uid));
  if (!profile.exists() || Number(profile.data().balance || 0) < fee) throw new Error(`Your wallet needs ${formatNaira(fee)} for this placement.`);
  return addDoc(collection(db, "promotionRequests"), {
    uid: user.uid, email: user.email || "", listingId: listing.id, listingTitle: listing.title || "",
    kind, amount: round2(fee), acceptedTerms: true, status: "pending",
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
}
export async function reviewListingPromotion(requestId, approve, adminUser, reason = "") {
  const actor = adminUser?.email || adminUser?.uid;
  if (!actor) throw new Error("Administrator identity is missing.");
  await runTransaction(db, async (t) => {
    const requestRef = doc(db, "promotionRequests", requestId);
    const requestSnap = await t.get(requestRef);
    if (!requestSnap.exists()) throw new Error("That promotion request no longer exists.");
    const request = requestSnap.data();
    if (request.status !== "pending") throw new Error("This promotion request has already been reviewed.");
    const listingRef = doc(db, LISTINGS, request.listingId);
    const listingSnap = await t.get(listingRef);
    if (!listingSnap.exists() || listingSnap.data().sellerUid !== request.uid || listingSnap.data().status !== "active") throw new Error("The product is no longer eligible for promotion.");
    const sellerRef = doc(db, "users", request.uid);
    const sellerSnap = await t.get(sellerRef);
    const txRef = doc(db, TRANSACTIONS, "promotion_" + requestId);
    const existingTx = await t.get(txRef);
    if (existingTx.exists()) throw new Error("A promotion charge already exists for this request.");
    const reviewedAt = serverTimestamp();
    const patch = { status: approve ? "approved" : "rejected", reviewedBy: actor, reviewedAt, updatedAt: reviewedAt,
      rejectionReason: approve ? "" : String(reason || "").trim().slice(0, 500) };
    if (approve) {
      if (!sellerSnap.exists()) throw new Error("The seller account is missing.");
      const balance = Number(sellerSnap.data().balance || 0);
      const fee = Number(request.amount);
      if (!Number.isFinite(fee) || fee <= 0 || balance < fee) throw new Error("The seller no longer has enough wallet balance for this placement.");
      const nextBalance = round2(balance - fee);
      const now = Date.now();
      const key = request.kind === "featured" ? "featuredUntil" : "hotDealUntil";
      const current = listingSnap.data()[key];
      const currentMs = current?.toDate ? current.toDate().getTime() : (current ? new Date(current).getTime() : 0);
      const expiresAt = new Date(Math.max(now, Number.isFinite(currentMs) ? currentMs : 0) + 24 * 60 * 60 * 1000);
      t.update(sellerRef, { balance: nextBalance, updatedAt: reviewedAt });
      t.update(listingRef, { [key]: expiresAt, updatedAt: reviewedAt });
      t.set(txRef, { type: "listing_promotion", direction: "debit", status: "completed", uid: request.uid,
        email: request.email || "", amount: fee, listingId: request.listingId, promotionRequestId: requestId,
        promotionKind: request.kind, reference: `${request.kind === "featured" ? "Featured" : "Hot Deals"} placement · ${request.listingTitle || "Listing"}`,
        balanceAfter: nextBalance, reviewedBy: actor, reviewedAt, createdAt: reviewedAt, updatedAt: reviewedAt });
      patch.expiresAt = expiresAt;
    }
    t.update(requestRef, patch);
  });
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
    const cancellationSnap = await t.get(doc(db, "cancellationRequests", order.id));
    if (cancellationSnap.exists() && ["pending", "approved"].includes(cancellationSnap.data().status)) throw new Error("This order payment is paused while its cancellation request is reviewed.");
    const plan = data.paymentMode === "installment";
    const count = plan ? Math.floor(Number(data.installmentCount || data.installmentMonths || 12)) : 0;
    if (["cancelled", "refunded", "completed"].includes(data.status) || (!plan && data.status !== "pending_payment") || (plan && data.installmentsPaid >= count)) {
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
    const listingRef = doc(db, LISTINGS, data.listingId);
    const reserveStock = data.stockReserved === false;
    const listingSnap = reserveStock ? await t.get(listingRef) : null;
    if (!buyer.exists() || !seller.exists()) throw new Error("The buyer or seller account is missing.");
    if (reserveStock && (!listingSnap || !listingSnap.exists())) throw new Error("The product listing is no longer available.");
    const payment = paymentSnap.exists() ? paymentSnap.data() : null;
    const due = plan ? installmentAmount(data.total, number, count) : Number(data.total);
    const payout = plan ? installmentAmount(data.sellerPayout, number, count) : Number(data.sellerPayout);
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
    const finalPayment = !plan || number === count;
    const finishDeliveredPlan = finalPayment && !!data.deliveredAt;
    let referralRef = null;
    let markFirst = false;
    if (finishDeliveredPlan && data.referrerUid) {
      referralRef = doc(db, REFERRALS, data.buyerUid);
      const referral = await t.get(referralRef);
      if (!referral.exists()) throw new Error("The referral record is missing.");
      markFirst = !referral.data().firstCompletedOrderId;
    }
    let stockAfter = null;
    if (reserveStock) {
      const available = Number(listingSnap.data().stock ?? 1);
      const quantity = Math.max(1, Math.floor(Number(data.quantity) || 1));
      if (!Number.isFinite(available) || available < quantity) throw new Error("There is not enough stock to confirm this order.");
      stockAfter = Math.max(0, available - quantity);
    }
    t.update(buyerRef, { balance: nextBuyer, updatedAt: serverTimestamp() });
    t.update(sellerRef, { balance: nextSeller, updatedAt: serverTimestamp() });
    t.update(paymentRef, { status: "completed", balanceAfter: nextBuyer, reviewedBy: reviewer,
      reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    t.set(doc(db, TRANSACTIONS, payoutId), { type: "order_payout", direction: "credit", status: "completed",
      uid: data.sellerUid, email: data.sellerEmail || "", orderId: order.id, installmentNumber: number,
      amount: payout, reference: data.listingTitle || "Marketplace order", balanceAfter: nextSeller,
      reviewedBy: reviewer, reviewedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    if (reserveStock) t.update(listingRef, {
      stock: stockAfter,
      soldCount: Number(listingSnap.data().soldCount || 0) + Math.max(1, Math.floor(Number(data.quantity) || 1)),
      updatedAt: serverTimestamp()
    });
    const status = finishDeliveredPlan ? "completed" : (data.status === "pending_payment" ? "paid" : data.status);
    const patch = { status, stockReserved: true, totalPaid: round2(Number(data.totalPaid || 0) + due), sellerPaid: round2(Number(data.sellerPaid || 0) + payout),
      installmentsPaid: plan ? number : 0, updatedAt: serverTimestamp(), timeline: arrayUnion(stamp(plan ? `instalment_${number}_paid` : "paid", reviewer)) };
    if (!data.paidAt) patch.paidAt = serverTimestamp();
    if (finalPayment) patch.fullyPaidAt = serverTimestamp();
    if (finishDeliveredPlan) patch.completedAt = serverTimestamp();
    t.update(orderRef, patch);
    if (markFirst) t.update(referralRef, { firstCompletedOrderId: order.id, firstPurchaseCompletedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    buyerLifetime(); sellerLifetime();
  });
}

export function cancellationQuote(order, choice) {
  const paid = round2(Number(order?.totalPaid || (order?.paymentMode === "installment" ? 0 : order?.total) || 0));
  if (!Number.isFinite(paid) || paid <= 0) throw new Error("There is no paid amount available for cancellation.");
  if (choice === "wallet_credit") return { amount: paid, fee: 0 };
  if (choice !== "wallet_refund") throw new Error("Choose wallet credit or a wallet refund.");
  const fee = Math.min(round2(Number(order.total || 0) * 0.2), paid);
  return { amount: round2(paid - fee), fee };
}

export async function requestOrderCancellation(orderId, choice) {
  const user = requireUser();
  if (!["wallet_credit", "wallet_refund"].includes(choice)) throw new Error("Choose a valid cancellation option.");
  await runTransaction(db, async (t) => {
    const orderRef = doc(db, ORDERS, orderId);
    const orderSnap = await t.get(orderRef);
    if (!orderSnap.exists()) throw new Error("That order no longer exists.");
    const order = orderSnap.data();
    if (order.buyerUid !== user.uid || order.status !== "paid" || order.deliveredAt) throw new Error("Paid-order cancellation is available before dispatch only. Contact support for a delivery issue.");
    const requestRef = doc(db, "cancellationRequests", orderId);
    const existing = await t.get(requestRef);
    if (existing.exists() && existing.data().status !== "rejected") throw new Error("A cancellation request is already open or has been approved.");
    const quote = cancellationQuote(order, choice);
    t.set(requestRef, { orderId, buyerUid: user.uid, buyerEmail: user.email || "", sellerUid: order.sellerUid,
      sellerEmail: order.sellerEmail || "", choice, requestedAmount: quote.amount, feeAmount: quote.fee, status: "pending",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  });
}

export function watchMyCancellationRequests(onRows, onError = console.error) {
  const user = requireUser();
  const q = query(collection(db, "cancellationRequests"), where("buyerUid", "==", user.uid));
  return onSnapshot(q, (snap) => onRows(rows(snap).sort((a, b) => new Date(b.createdAt?.toDate?.() || b.createdAt || 0) - new Date(a.createdAt?.toDate?.() || a.createdAt || 0))), onError);
}
export function watchAllCancellationRequests(onRows, onError = console.error) {
  const q = query(collection(db, "cancellationRequests"), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}
export async function reviewOrderCancellation(orderId, approve, adminUser, reason = "") {
  const actor = adminUser?.email || adminUser?.uid;
  if (!actor) throw new Error("Administrator identity is missing.");
  await runTransaction(db, async (t) => {
    const requestRef = doc(db, "cancellationRequests", orderId);
    const requestSnap = await t.get(requestRef);
    if (!requestSnap.exists() || requestSnap.data().status !== "pending") throw new Error("No pending cancellation request exists.");
    const request = requestSnap.data();
    const orderRef = doc(db, ORDERS, orderId);
    const orderSnap = await t.get(orderRef);
    if (!orderSnap.exists()) throw new Error("That order no longer exists.");
    const order = orderSnap.data();
    if (order.buyerUid !== request.buyerUid || order.status !== "paid" || order.deliveredAt) throw new Error("This order is no longer eligible for pre-dispatch cancellation.");
    const buyerRef = doc(db, "users", request.buyerUid);
    const buyerSnap = await t.get(buyerRef);
    if (!buyerSnap.exists()) throw new Error("The buyer account is missing.");
    const transactionRef = doc(db, TRANSACTIONS, "order_refund_" + orderId);
    const previous = await t.get(transactionRef);
    const updatedAt = serverTimestamp();
    if (!approve) {
      if (previous.exists()) throw new Error("A refund has already been recorded for this order.");
      const rejectionReason = String(reason || "").trim().slice(0, 500);
      t.update(requestRef, { status: "rejected", rejectionReason, reviewedBy: actor, reviewedAt: updatedAt, updatedAt });
      t.set(doc(collection(db, MAIL)), { to: order.buyerEmail, orderId,
        notificationType: "cancellation_rejected",
        message: { subject: `Cancellation request update · ${order.listingTitle || "MailMart order"}`,
          html: `<h2>Cancellation request update</h2><p>Your request for <b>${escapeHtml(order.listingTitle || "this order")}</b> was not approved.</p>${rejectionReason ? `<p>Reason: ${escapeHtml(rejectionReason)}</p>` : ""}<p>Your order remains active. Contact MailMart support if you need assistance.</p>` } });
      return;
    }
    if (previous.exists()) throw new Error("A refund has already been recorded for this order.");
    const quote = cancellationQuote(order, request.choice);
    const balance = Number(buyerSnap.data().balance || 0);
    const balanceAfter = round2(balance + quote.amount);
    if (!(quote.amount > 0) || !Number.isFinite(balanceAfter)) throw new Error("The cancellation does not produce a payable wallet credit.");
    const listingRef = doc(db, LISTINGS, order.listingId);
    const listingSnap = order.stockReserved === true && order.status === "paid" ? await t.get(listingRef) : null;
    t.update(buyerRef, { balance: balanceAfter, updatedAt });
    t.set(transactionRef, { type: "order_refund", direction: "credit", status: "completed", uid: request.buyerUid,
      email: order.buyerEmail || "", orderId, cancellationRequestId: orderId, amount: quote.amount, feeAmount: quote.fee,
      reference: `Voluntary cancellation · ${order.listingTitle || "Marketplace order"}`, balanceAfter,
      reviewedBy: actor, reviewedAt: updatedAt, createdAt: updatedAt, updatedAt });
    const timelineStatus = request.choice === "wallet_credit" ? "cancelled" : "refunded";
    t.update(orderRef, { status: timelineStatus, refundedAt: timelineStatus === "refunded" ? updatedAt : null,
      cancellationReason: "Buyer requested pre-dispatch cancellation", cancellationChoice: request.choice,
      refundAmount: quote.amount, refundFee: quote.fee, stockReserved: listingSnap?.exists() ? false : (order.stockReserved ?? false),
      updatedAt, timeline: arrayUnion(stamp(timelineStatus, actor)) });
    if (listingSnap?.exists()) {
      const quantity = Math.max(1, Math.floor(Number(order.quantity) || 1));
      const data = listingSnap.data();
      t.update(listingRef, { stock: Number(data.stock ?? 0) + quantity,
        soldCount: Math.max(0, Number(data.soldCount || 0) - quantity), updatedAt });
    }
    t.update(requestRef, { status: "approved", requestedAmount: quote.amount, feeAmount: quote.fee, reviewedBy: actor,
      reviewedAt: updatedAt, updatedAt });
    t.set(doc(collection(db, MAIL)), { to: order.buyerEmail, orderId, notificationType: "cancellation_approved",
      message: { subject: `Cancellation approved · ${order.listingTitle || "MailMart order"}`,
        html: `<h2>Cancellation approved</h2><p>Your order for <b>${escapeHtml(order.listingTitle || "this item")}</b> has been cancelled before dispatch.</p><p>${request.choice === "wallet_credit" ? "Full amount paid credited to your wallet" : "Wallet refund credited after the policy fee"}: <b>${formatNaira(quote.amount)}</b>${quote.fee ? `<br>Fee retained: ${formatNaira(quote.fee)}` : ""}.</p><p>You can use the wallet amount on another MailMart order.</p>` } });
  });
}

/** Return a paid order's money to the buyer when MailMart or the seller cannot fulfill it. Administrator only. */
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
    const cancellationRef = doc(db, "cancellationRequests", order.id);
    const cancellationSnap = await t.get(cancellationRef);
    const restoreStock = data.status === "paid" && data.stockReserved === true;
    const listingRef = doc(db, LISTINGS, data.listingId);
    const listingSnap = restoreStock ? await t.get(listingRef) : null;

    const refundAmount = data.paymentMode === "installment" ? Number(data.totalPaid || 0) : Number(data.totalPaid || data.total || 0);
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error("There is no paid amount to refund.");
    const refunded = round2(Number(buyerSnap.data().balance || 0) + refundAmount);
    const reviewedAt = serverTimestamp();
    t.update(buyerRef, { balance: refunded, updatedAt: reviewedAt });

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
      reviewedAt,
      createdAt: reviewedAt,
      updatedAt: reviewedAt
    });

    t.update(doc(db, ORDERS, order.id), {
      status: "refunded",
      refundedAt: reviewedAt,
      refundAmount,
      refundFee: 0,
      cancellationReason: "MailMart or seller could not fulfill the order",
      ...(restoreStock ? { stockReserved: false } : {}),
      updatedAt: reviewedAt,
      timeline: arrayUnion(stamp("refunded", adminUser?.email || adminUser?.uid))
    });
    t.set(doc(collection(db, MAIL)), { to: data.buyerEmail, orderId: order.id, notificationType: "fulfillment_refund",
      message: { subject: `Order refund · ${data.listingTitle || "MailMart order"}`,
        html: `<h2>MailMart could not complete your order</h2><p>We are sorry that <b>${escapeHtml(data.listingTitle || "your item")}</b> could not be fulfilled.</p><p>A full refund of the amount paid, <b>${formatNaira(refundAmount)}</b>, has been credited to your MailMart wallet.</p><p>Sign in to view your wallet and order history, or contact support if you need help.</p>` } });
    if (listingSnap?.exists()) {
      const quantity = Math.max(1, Math.floor(Number(data.quantity) || 1));
      const listing = listingSnap.data();
      t.update(listingRef, { stock: Number(listing.stock ?? 0) + quantity,
        soldCount: Math.max(0, Number(listing.soldCount || 0) - quantity), updatedAt: reviewedAt });
    }
    if (cancellationSnap.exists() && cancellationSnap.data().status === "pending") {
      t.update(cancellationRef, { status: "superseded", rejectionReason: "A full fulfillment refund was issued instead.",
        reviewedBy: adminUser?.email || adminUser?.uid || "", reviewedAt, updatedAt: reviewedAt });
    }
  });
}
