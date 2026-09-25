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
  const serviceFee = round2(Number(settings?.serviceFee || 0));
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
export async function placeOrder({ listing, quantity, address, settings }) {
  const user = requireUser();
  const quote = quoteFor(listing, quantity, address.state, settings);

  if (Number(listing.stock ?? 1) < 1) throw new Error("This item is out of stock.");
  if (!listing.sellerEmail) throw new Error("That listing has no seller attached.");

  const orderRef = doc(collection(db, ORDERS));
  const txRef = doc(collection(db, TRANSACTIONS));

  const batch = writeBatch(db);

  batch.set(orderRef, {
    listingId: listing.id,
    listingTitle: listing.title || "",
    listingImage: listing.image || "",
    buyerUid: user.uid,
    buyerEmail: user.email || "",
    sellerUid: listing.sellerUid || "",
    sellerEmail: listing.sellerEmail || "",
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
    amount: quote.total,
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
export async function advanceOrder(order, status, actor) {
  const allowed = TRANSITIONS[status] || [];
  if (!allowed.includes(order.status)) {
    throw new Error(`An order that is ${STATUS_LABEL[order.status] || order.status} cannot become ${STATUS_LABEL[status] || status}.`);
  }
  const patch = {
    status,
    updatedAt: serverTimestamp(),
    timeline: arrayUnion(stamp(status, actor))
  };
  if (status === "completed") patch.completedAt = serverTimestamp();
  await updateDoc(doc(db, ORDERS, order.id), patch);
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
 */
export async function settleOrderPayment(order, adminUser) {
  await runTransaction(db, async (t) => {
    const orderSnap = await t.get(doc(db, ORDERS, order.id));
    if (!orderSnap.exists()) throw new Error("That order no longer exists.");
    const data = orderSnap.data();
    if (data.status !== "pending_payment") {
      throw new Error(`This order is already ${STATUS_LABEL[data.status] || data.status}.`);
    }

    const buyerRef = doc(db, "users", data.buyerUid);
    const sellerRef = doc(db, "users", data.sellerUid);
    const buyerSnap = await t.get(buyerRef);
    const sellerSnap = await t.get(sellerRef);
    if (!buyerSnap.exists()) throw new Error("The buyer account is missing.");

    const buyerBalance = Number(buyerSnap.data().balance || 0);
    const total = Number(data.total || 0);
    if (buyerBalance < total) {
      throw new Error(`The buyer has ${formatNaira(buyerBalance)} but this order costs ${formatNaira(total)}.`);
    }

    const payout = Number(data.sellerPayout || 0);
    const nextBuyer = round2(buyerBalance - total);
    const nextSeller = sellerSnap.exists()
      ? round2(Number(sellerSnap.data().balance || 0) + payout)
      : payout;
    if (!sellerSnap.exists()) throw new Error("The seller account is missing.");

    t.update(buyerRef, { balance: nextBuyer, updatedAt: serverTimestamp() });
    t.update(sellerRef, { balance: nextSeller, updatedAt: serverTimestamp() });

    t.update(doc(db, ORDERS, order.id), {
      status: "paid",
      paidAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      timeline: arrayUnion(stamp("paid", adminUser.email))
    });
  });
}

/** Return a paid order's money to the buyer. Administrator only. */
export async function refundOrder(order, adminUser) {
  await runTransaction(db, async (t) => {
    const snap = await t.get(doc(db, ORDERS, order.id));
    if (!snap.exists()) throw new Error("That order no longer exists.");
    const data = snap.data();
    if (!["paid", "shipped"].includes(data.status)) {
      throw new Error(`An order that is ${STATUS_LABEL[data.status] || data.status} cannot be refunded.`);
    }

    const buyerRef = doc(db, "users", data.buyerUid);
    const buyerSnap = await t.get(buyerRef);
    if (!buyerSnap.exists()) throw new Error("The buyer account is missing.");

    const refunded = round2(Number(buyerSnap.data().balance || 0) + Number(data.total || 0));
    t.update(buyerRef, { balance: refunded, updatedAt: serverTimestamp() });

    t.update(doc(db, ORDERS, order.id), {
      status: "refunded",
      refundedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      timeline: arrayUnion(stamp("refunded", adminUser.email))
    });
  });
}
