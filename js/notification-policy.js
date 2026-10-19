// Notification policy — pure, dependency-free, and therefore testable.
//
// MailMart does not push notifications from the browser: a GitHub Actions job
// (scripts/notify-worker.mjs) reads Firestore with the Admin SDK, folds each
// changed record through this same module, and delivers a phone alert through
// ntfy. The browser runs the identical matching for its in-app bell. Keeping
// the matching in one pure module is what stops the two from disagreeing.
//
// The administrator owns both halves of the decision:
//   settings/notifications { channels, audiences, events }
// and resolvePolicy() folds that document over the defaults below. A missing
// document, a half-saved one, or one written by an older version of the site
// all resolve to something safe.

/* ------------------------------------------------------------------ */
/* record language                                                     */
/* ------------------------------------------------------------------ */

/** The marketplace's order statuses, in the words a customer understands. */
export const ORDER_STATUS_LABEL = {
  pending_payment: "Awaiting payment",
  paid: "Paid",
  shipped: "Dispatched",
  completed: "Completed",
  delivered_pending_balance: "Delivered · balance outstanding",
  cancelled: "Cancelled",
  refunded: "Refunded"
};

/** Wallet-ledger statuses. */
export const TRANSACTION_STATUS_LABEL = {
  pending: "Pending",
  approved: "Approved",
  completed: "Completed",
  rejected: "Rejected",
  refunded: "Refunded"
};

/** Service requests (social purchases and one-time email codes). */
export const SERVICE_STATUS_LABEL = {
  pending: "Pending review",
  awaiting_code: "Awaiting code",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
  refunded: "Refunded"
};

/** Seller verification. */
export const KYC_STATUS_LABEL = {
  pending: "Pending review",
  approved: "Approved",
  rejected: "Not approved"
};

export const AUDIENCE_LABEL = {
  buyer: "Buyer",
  seller: "Seller",
  account: "Account holder",
  admin: "Administrator"
};

/** Which collection feeds each source. */
export const SOURCE_LABEL = {
  order: "Marketplace order",
  transaction: "Wallet",
  service: "Digital service",
  kyc: "Seller verification"
};

/* ------------------------------------------------------------------ */
/* the catalogue                                                       */
/* ------------------------------------------------------------------ */

/**
 * Every event that can raise a notification.
 *
 *   source    order | transaction | service | kyc
 *   statuses  the record statuses that trigger it
 *   types     transaction-only: which ledger `type` values count
 *   collection service-only: "socialRequests" or "rentals"
 *   audience  who receives it (recipientFor() below)
 *
 * Placeholders in title/body: orderId, item, total, amount, reference,
 * statusLabel, typeLabel, buyer, seller, recipient.
 */
export const EVENT_CATALOG = [
  /* ---------------------------- orders ---------------------------- */
  {
    id: "buyer_placed",
    source: "order",
    audience: "buyer",
    statuses: ["pending_payment"],
    label: "Order received",
    hint: "Sent to the buyer the moment an order is placed, before payment is confirmed.",
    title: "Order received",
    body: "We have your order {orderId} for {item}. MailMart will confirm your payment shortly."
  },
  {
    id: "buyer_paid",
    source: "order",
    audience: "buyer",
    statuses: ["paid"],
    label: "Payment confirmed",
    hint: "Sent to the buyer once an administrator confirms their payment.",
    title: "Payment confirmed",
    body: "We received your payment for order {orderId}. The seller will dispatch it soon."
  },
  {
    id: "buyer_shipped",
    source: "order",
    audience: "buyer",
    statuses: ["shipped"],
    label: "Order dispatched",
    hint: "The one in the screenshot — sent when the seller marks the order shipped.",
    title: "Order Update",
    body: "Your order {orderId} has been dispatched! Track your order in your dashboard."
  },
  {
    id: "buyer_completed",
    source: "order",
    audience: "buyer",
    statuses: ["completed"],
    label: "Order completed",
    hint: "Sent when delivery is confirmed and the order closes.",
    title: "Order delivered",
    body: "Order {orderId} is now complete. Thanks for shopping with MailMart."
  },
  {
    id: "buyer_balance_due",
    source: "order",
    audience: "buyer",
    statuses: ["delivered_pending_balance"],
    label: "Delivered — balance outstanding",
    hint: "Sent when an instalment order is delivered with money still owed.",
    title: "Balance still due",
    body: "Order {orderId} was delivered with a balance outstanding. Settle the rest from your orders page."
  },
  {
    id: "buyer_cancelled",
    source: "order",
    audience: "buyer",
    statuses: ["cancelled", "refunded"],
    label: "Order cancelled or refunded",
    hint: "Covers both a cancellation and a refunded order.",
    title: "Order {statusLabel}",
    body: "Order {orderId} is now {statusLabel}. Any refund due is credited to your MailMart wallet."
  },
  {
    id: "seller_placed",
    source: "order",
    audience: "seller",
    statuses: ["pending_payment"],
    label: "New order received",
    hint: "Sent to the seller when a buyer places an order.",
    title: "New order",
    body: "You have a new order {orderId} for {item}. It is shown as awaiting payment until MailMart confirms it."
  },
  {
    id: "seller_paid",
    source: "order",
    audience: "seller",
    statuses: ["paid"],
    label: "Payment confirmed for your sale",
    hint: "Sent to the seller once MailMart confirms the buyer's payment.",
    title: "Payment received",
    body: "Payment for order {orderId} is confirmed. Prepare {item} for dispatch."
  },
  {
    id: "seller_completed",
    source: "order",
    audience: "seller",
    statuses: ["completed"],
    label: "Delivery confirmed on your sale",
    hint: "Sent to the seller when the buyer confirms delivery.",
    title: "Delivery confirmed",
    body: "The buyer confirmed delivery of order {orderId}. Your payout has been released."
  },
  {
    id: "admin_placed",
    source: "order",
    audience: "admin",
    statuses: ["pending_payment"],
    label: "New order waiting for payment",
    hint: "Sent to administrators so a new order can be checked and confirmed.",
    title: "New order awaiting payment",
    body: "Order {orderId} for {item} ({total}) is waiting for a payment check."
  },

  /* ---------------------------- wallet ---------------------------- */
  {
    id: "wallet_deposit_approved",
    source: "transaction",
    audience: "account",
    types: ["deposit"],
    statuses: ["completed"],
    label: "Deposit approved",
    hint: "Sent when an administrator confirms a bank deposit.",
    title: "Deposit confirmed",
    body: "Your deposit of {amount} has been added to your MailMart wallet."
  },
  {
    id: "wallet_deposit_rejected",
    source: "transaction",
    audience: "account",
    types: ["deposit"],
    statuses: ["rejected"],
    label: "Deposit declined",
    hint: "Sent when a deposit receipt cannot be verified.",
    title: "Deposit not confirmed",
    body: "We could not confirm your deposit of {amount}. Open your wallet for the reason and next steps."
  },
  {
    id: "wallet_withdrawal_paid",
    source: "transaction",
    audience: "account",
    types: ["withdrawal"],
    statuses: ["completed"],
    label: "Withdrawal paid",
    hint: "Sent when an administrator marks a withdrawal as paid out.",
    title: "Withdrawal sent",
    body: "Your withdrawal of {amount} has been paid out."
  },
  {
    id: "wallet_withdrawal_rejected",
    source: "transaction",
    audience: "account",
    types: ["withdrawal"],
    statuses: ["rejected"],
    label: "Withdrawal declined",
    hint: "Sent when a withdrawal cannot be completed; the balance stays in the wallet.",
    title: "Withdrawal not completed",
    body: "Your withdrawal of {amount} was declined and the balance remains in your wallet."
  },
  {
    id: "wallet_payout",
    source: "transaction",
    audience: "account",
    types: ["order_payout", "email_payout"],
    statuses: ["completed"],
    label: "Seller payout released",
    hint: "Sent when a sale payout (marketplace or email sale) is credited.",
    title: "Payout released",
    body: "A payout of {amount} has been credited to your wallet."
  },
  {
    id: "wallet_refund",
    source: "transaction",
    audience: "account",
    types: ["order_refund", "rental_refund", "admin_credit"],
    statuses: ["completed"],
    label: "Refund or credit credited",
    hint: "Sent when a refund, service refund or manual credit lands in the wallet.",
    title: "Wallet credited",
    body: "{amount} has been credited to your MailMart wallet."
  },

  /* ------------------------ digital services ---------------------- */
  {
    id: "service_social_reviewed",
    source: "service",
    collection: "socialRequests",
    audience: "account",
    statuses: ["completed", "rejected", "refunded"],
    label: "Social account request reviewed",
    hint: "Sent when MailMart completes or rejects a social account purchase request.",
    title: "Social request {statusLabel}",
    body: "Your request “{item}” is now {statusLabel}."
  },
  {
    id: "service_rental_update",
    source: "service",
    collection: "rentals",
    audience: "account",
    statuses: ["awaiting_code", "completed", "rejected", "refunded"],
    label: "Email code request updated",
    hint: "Sent when a one-time email code is assigned, delivered, rejected or refunded.",
    title: "Email code {statusLabel}",
    body: "Your {item} code request is now {statusLabel}. Open Services for the next step."
  },

  /* ---------------------- seller verification --------------------- */
  {
    id: "seller_verified",
    source: "kyc",
    audience: "seller",
    statuses: ["approved", "rejected"],
    label: "Seller verification decided",
    hint: "Sent when an administrator approves or rejects a seller application.",
    title: "Seller verification {statusLabel}",
    body: "Your seller verification was {statusLabel}. Open Sell to see what happens next."
  }
];

/* ------------------------------------------------------------------ */
/* policy document                                                     */
/* ------------------------------------------------------------------ */

export const POLICY_DOC_PATH = ["settings", "notifications"];

const MAX_TITLE = 80;
const MAX_BODY = 300;

function readBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function readText(value, fallback, maximum) {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (!text) return fallback;
  return text.slice(0, maximum);
}

function defaultsFor(event) {
  return { enabled: true, title: event.title, body: event.body };
}

/**
 * Turn the administrator's stored document (or nothing at all) into the policy
 * every page uses. Unknown events are ignored, unknown fields are dropped, and
 * blank wording falls back to the catalogue default rather than rendering an
 * empty notification.
 */
export function resolvePolicy(stored) {
  const source = stored && typeof stored === "object" ? stored : {};
  const channels = source.channels && typeof source.channels === "object" ? source.channels : {};
  const storedEvents = source.events && typeof source.events === "object" ? source.events : {};
  const audiences = source.audiences && typeof source.audiences === "object" ? source.audiences : {};

  const events = {};
  for (const event of EVENT_CATALOG) {
    const saved = storedEvents[event.id] && typeof storedEvents[event.id] === "object"
      ? storedEvents[event.id]
      : {};
    const fallback = defaultsFor(event);
    events[event.id] = {
      enabled: readBoolean(saved.enabled, fallback.enabled),
      title: readText(saved.title, fallback.title, MAX_TITLE),
      body: readText(saved.body, fallback.body, MAX_BODY)
    };
  }

  return {
    channels: {
      inApp: readBoolean(channels.inApp, true),
      browser: readBoolean(channels.browser, true),
      sound: readBoolean(channels.sound, true),
      // Closed-app delivery through ntfy, run by the scheduled sender.
      phone: readBoolean(channels.phone, true)
    },
    // Master switches: turning "Buyer" off silences every buyer event without
    // losing the wording that was configured for it.
    audiences: {
      buyer: readBoolean(audiences.buyer, true),
      seller: readBoolean(audiences.seller, true),
      account: readBoolean(audiences.account, true),
      admin: readBoolean(audiences.admin, true)
    },
    events
  };
}

/** A policy document ready to save, with only known fields. */
export function serializePolicy(policy) {
  const resolved = resolvePolicy(policy);
  const events = {};
  for (const event of EVENT_CATALOG) {
    events[event.id] = {
      enabled: resolved.events[event.id].enabled,
      title: resolved.events[event.id].title,
      body: resolved.events[event.id].body
    };
  }
  return {
    version: 1,
    channels: { ...resolved.channels },
    audiences: { ...resolved.audiences },
    events
  };
}

/* ------------------------------------------------------------------ */
/* formatting helpers                                                  */
/* ------------------------------------------------------------------ */

/** Naira with two decimals, no Intl dependency. */
export function formatNaira(value) {
  const amount = Number(value);
  const safe = Number.isFinite(amount) ? amount : 0;
  return "₦" + safe.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `#A1B2C3D4` style reference for an order, stable and short. */
export function orderReference(order) {
  const explicit = order?.orderNumber || order?.code;
  if (typeof explicit === "string" && explicit.trim()) return explicit.startsWith("#") ? explicit : "#" + explicit.trim();
  const id = String(order?.id || "");
  return id ? "#" + id.slice(0, 8).toUpperCase() : "#ORDER";
}

/** Firestore Timestamp | Date | ISO string | millis → milliseconds. */
export function timestampMs(value) {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value?.toMillis === "function") {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Fill `{tokens}` from `values`; unknown tokens are left alone on purpose. */
export function renderTemplate(template, values = {}) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
}

const TRANSACTION_TYPE_LABEL = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  order_payment: "Order payment",
  order_payout: "Order payout",
  order_refund: "Order refund",
  email_payout: "Email sale payout",
  listing_fee: "Listing fee",
  listing_promotion: "Listing promotion",
  admin_credit: "Wallet credit",
  rental_payment: "Email code payment",
  rental_refund: "Email code refund",
  social_purchase: "Social account purchase",
  affiliate_commission: "Affiliate commission",
  lifetime_commission: "Lifetime commission",
  purchase_referral: "Referral reward",
  purchase_welcome: "Welcome reward",
  email_referral: "Email referral reward"
};

/** Status label for whichever kind of record this is. */
export function statusLabelFor(kind, status) {
  const labels = {
    order: ORDER_STATUS_LABEL,
    transaction: TRANSACTION_STATUS_LABEL,
    socialRequests: SERVICE_STATUS_LABEL,
    rentals: SERVICE_STATUS_LABEL,
    kyc: KYC_STATUS_LABEL
  }[kind] || {};
  return labels[status] || status || "updated";
}

function templateValues(kind, record) {
  const status = String(record?.status || "");
  const values = {
    status,
    statusLabel: statusLabelFor(kind, status),
    orderId: orderReference(record),
    item: record?.listingTitle || record?.listingName || record?.title || record?.categoryName ||
      record?.fullName || TRANSACTION_TYPE_LABEL[record?.type] || "your request",
    total: formatNaira(record?.total),
    amount: formatNaira(record?.amount),
    reference: record?.reference || record?.id || "",
    typeLabel: TRANSACTION_TYPE_LABEL[record?.type] || record?.type || "",
    buyer: record?.buyerEmail || "the buyer",
    seller: record?.sellerEmail || "the seller"
  };
  values.recipient = values.item;
  return values;
}

/* ------------------------------------------------------------------ */
/* matching                                                            */
/* ------------------------------------------------------------------ */

const KIND_FOR_SOURCE = {
  order: "order",
  transaction: "transaction",
  kyc: "kyc"
};

function normalize(input = {}) {
  const records = [];
  const push = (kind, row) => {
    if (row && typeof row === "object" && row.id) records.push({ kind, record: row });
  };
  for (const row of input.orders || []) push("order", row);
  for (const row of input.transactions || []) push("transaction", row);
  for (const row of input.services || []) push(row._kind || "socialRequests", row);
  for (const row of input.verifications || []) push("kyc", row);
  return records;
}

function eventMatches(event, kind, record) {
  if (event.source === "order") {
    if (kind !== "order") return false;
  } else if (event.source === "transaction") {
    if (kind !== "transaction") return false;
    if (event.types && !event.types.includes(record.type)) return false;
  } else if (event.source === "service") {
    if (kind !== (event.collection || "socialRequests")) return false;
  } else if (event.source === "kyc") {
    if (kind !== KIND_FOR_SOURCE.kyc) return false;
  } else {
    return false;
  }
  return event.statuses.includes(String(record.status || ""));
}

/** Who receives this event for this record. */
export function recipientUidsFor(event, record, adminUids = []) {
  if (event.audience === "admin") return [...adminUids];
  if (event.audience === "buyer") return record?.buyerUid ? [record.buyerUid] : [];
  if (event.audience === "seller") return record?.sellerUid ? [record.sellerUid] : (record?.uid ? [record.uid] : []);
  if (event.audience === "account") return record?.uid ? [record.uid] : [];
  return [];
}

/** Stable key: one notification per event per record, ever. */
export function notificationKey(eventId, kind, recordId) {
  return `${eventId}:${kind}:${recordId}`;
}

/**
 * Every alert the policy currently allows, across all audiences. This is the
 * single matching engine: the bell filters it by uid, the scheduled sender
 * iterates it and delivers each alert to its recipients.
 */
export function collectAlerts({
  orders = [],
  transactions = [],
  services = [],
  verifications = [],
  adminUids = [],
  policy
} = {}) {
  const resolved = policy?.events ? policy : resolvePolicy(policy);
  const alerts = [];
  const seen = new Set();

  for (const { kind, record } of normalize({ orders, transactions, services, verifications })) {
    for (const event of EVENT_CATALOG) {
      const settings = resolved.events[event.id];
      if (!settings || !settings.enabled) continue;
      if (resolved.audiences?.[event.audience] === false) continue;
      if (!eventMatches(event, kind, record)) continue;

      const key = notificationKey(event.id, kind, record.id);
      if (seen.has(key)) continue;

      const recipients = recipientUidsFor(event, record, adminUids);
      if (!recipients.length) continue;
      seen.add(key);

      const values = templateValues(kind, record);
      alerts.push({
        key,
        eventId: event.id,
        source: event.source,
        audience: event.audience,
        kind,
        recordId: record.id,
        status: String(record.status || ""),
        recipientUids: recipients,
        title: renderTemplate(settings.title, values),
        body: renderTemplate(settings.body, values),
        at: timestampMs(record.updatedAt) || timestampMs(record.createdAt) || Date.now()
      });
    }
  }

  return alerts.sort((a, b) => b.at - a.at);
}

/**
 * The feed for one signed-in person, from the records their rules already let
 * them read. Newest first; one entry per event per record.
 */
export function buildNotificationItems({
  orders = [],
  transactions = [],
  services = [],
  verifications = [],
  uid = "",
  isAdmin = false,
  policy
} = {}) {
  const adminUids = isAdmin && uid ? [uid] : [];
  return collectAlerts({ orders, transactions, services, verifications, adminUids, policy })
    .filter((alert) => alert.recipientUids.includes(uid))
    .map((alert) => ({
      key: alert.key,
      eventId: alert.eventId,
      audience: alert.audience,
      kind: alert.kind,
      recordId: alert.recordId,
      orderId: alert.kind === "order" ? alert.recordId : "",
      item: alert.title,
      title: alert.title,
      body: alert.body,
      at: alert.at
    }));
}

/** Items the reader has not seen yet. `readKeys` is an array or a Set. */
export function unreadItems(items, readKeys) {
  const seen = readKeys instanceof Set ? readKeys : new Set(readKeys || []);
  return (items || []).filter((item) => !seen.has(item.key));
}

/** A short, unguessable ntfy topic for one account. */
export function topicForUid(uid, salt = "") {
  const clean = String(uid || "").replace(/[^A-Za-z0-9]/g, "");
  const mix = String(salt || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  if (clean.length < 8) throw new Error("A topic needs a real account id.");
  return "mailmart-" + clean.slice(0, 20).toLowerCase() + (mix ? "-" + mix.toLowerCase() : "");
}
