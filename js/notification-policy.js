// Notification policy — pure, dependency-free, and therefore testable.
//
// MailMart does not push notifications from a server: there is no backend in
// this repository. Instead every page the user already has open listens to the
// same Firestore data it always read (their orders), and turns order changes
// into notification items. This module is the part that decides *what* becomes
// a notification and *what wording* it uses. The administrator owns both:
// settings/notifications stores an enable flag plus a title and body per event,
// and resolvePolicy() folds that document over the defaults below.
//
// Nothing here talks to Firebase or the DOM, so the rules can be tested
// directly (tests/notifications.test.mjs) instead of only in a browser.

/* ------------------------------------------------------------------ */
/* order language                                                      */
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

export const AUDIENCE_LABEL = {
  buyer: "Buyer",
  seller: "Seller",
  admin: "Administrator"
};

/**
 * The catalogue of things that can raise a notification.
 *
 * `statuses` is the order status that triggers the event. Each event gets its
 * own key per order, so an order moving paid → shipped → completed produces
 * three separate entries rather than one mutating entry in the feed.
 *
 * `field` names in `{braces}` are filled by renderTemplate():
 *   orderId, status, statusLabel, item, total, buyer, seller
 */
export const EVENT_CATALOG = [
  {
    id: "buyer_placed",
    audience: "buyer",
    statuses: ["pending_payment"],
    label: "Order received",
    hint: "Sent to the buyer the moment an order is placed, before payment is confirmed.",
    title: "Order received",
    body: "We have your order {orderId} for {item}. MailMart will confirm your payment shortly."
  },
  {
    id: "buyer_paid",
    audience: "buyer",
    statuses: ["paid"],
    label: "Payment confirmed",
    hint: "Sent to the buyer once an administrator confirms their payment.",
    title: "Payment confirmed",
    body: "We received your payment for order {orderId}. The seller will dispatch it soon."
  },
  {
    id: "buyer_shipped",
    audience: "buyer",
    statuses: ["shipped"],
    label: "Order dispatched",
    hint: "The one in your screenshot — sent when the seller marks the order shipped.",
    title: "Order Update",
    body: "Your order {orderId} has been dispatched! Track your order in your dashboard."
  },
  {
    id: "buyer_completed",
    audience: "buyer",
    statuses: ["completed"],
    label: "Order completed",
    hint: "Sent when delivery is confirmed and the order closes.",
    title: "Order delivered",
    body: "Order {orderId} is now complete. Thanks for shopping with MailMart."
  },
  {
    id: "buyer_balance_due",
    audience: "buyer",
    statuses: ["delivered_pending_balance"],
    label: "Delivered — balance outstanding",
    hint: "Sent when an instalment order is delivered with money still owed.",
    title: "Balance still due",
    body: "Order {orderId} was delivered with a balance outstanding. Settle the rest from your orders page."
  },
  {
    id: "buyer_cancelled",
    audience: "buyer",
    statuses: ["cancelled", "refunded"],
    label: "Order cancelled or refunded",
    hint: "Covers both a cancellation and a refunded order.",
    title: "Order {statusLabel}",
    body: "Order {orderId} is now {statusLabel}. Any refund due is credited to your MailMart wallet."
  },
  {
    id: "seller_placed",
    audience: "seller",
    statuses: ["pending_payment"],
    label: "New order received",
    hint: "Sent to the seller when a buyer places an order.",
    title: "New order",
    body: "You have a new order {orderId} for {item}. It is shown as awaiting payment until MailMart confirms it."
  },
  {
    id: "seller_paid",
    audience: "seller",
    statuses: ["paid"],
    label: "Payment confirmed for your sale",
    hint: "Sent to the seller once MailMart confirms the buyer's payment.",
    title: "Payment received",
    body: "Payment for order {orderId} is confirmed. Prepare {item} for dispatch."
  },
  {
    id: "seller_completed",
    audience: "seller",
    statuses: ["completed"],
    label: "Delivery confirmed on your sale",
    hint: "Sent to the seller when the buyer confirms delivery.",
    title: "Delivery confirmed",
    body: "The buyer confirmed delivery of order {orderId}. Your payout has been released."
  },
  {
    id: "admin_placed",
    audience: "admin",
    statuses: ["pending_payment"],
    label: "New order waiting for payment",
    hint: "Sent to administrators so a new order can be checked and confirmed.",
    title: "New order awaiting payment",
    body: "Order {orderId} for {item} ({total}) is waiting for a payment check."
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
 * every page uses. A missing document, a half-saved one, or one written by an
 * older version of the site all resolve to something safe: unknown events are
 * ignored, unknown fields are dropped, and blank wording falls back to the
 * catalogue default rather than rendering an empty notification.
 */
export function resolvePolicy(stored) {
  const source = stored && typeof stored === "object" ? stored : {};
  const channels = source.channels && typeof source.channels === "object" ? source.channels : {};
  const storedEvents = source.events && typeof source.events === "object" ? source.events : {};

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

  const audiences = source.audiences && typeof source.audiences === "object" ? source.audiences : {};

  return {
    channels: {
      inApp: readBoolean(channels.inApp, true),
      browser: readBoolean(channels.browser, true),
      sound: readBoolean(channels.sound, true)
    },
    // A master switch per audience: turning "Buyer" off silences every buyer
    // event without losing the wording that was configured for it.
    audiences: {
      buyer: readBoolean(audiences.buyer, true),
      seller: readBoolean(audiences.seller, true),
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
/* rendering notification items                                         */
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

function templateValues(order, audience) {
  const status = String(order?.status || "");
  return {
    orderId: orderReference(order),
    status,
    statusLabel: ORDER_STATUS_LABEL[status] || status || "updated",
    item: order?.listingTitle || order?.listingName || "your item",
    total: formatNaira(order?.total),
    buyer: order?.buyerEmail || "the buyer",
    seller: order?.sellerEmail || "the seller",
    audience: AUDIENCE_LABEL[audience] || audience
  };
}

function audienceMatches(event, { order, uid, isAdmin }) {
  if (event.audience === "buyer") return !!uid && order.buyerUid === uid;
  if (event.audience === "seller") return !!uid && order.sellerUid === uid;
  return isAdmin === true;
}

/**
 * Build the notification feed a signed-in person should see from the orders
 * their security rules already allow them to read.
 *
 * Returns items newest-first:
 *   { key, eventId, audience, orderId, orderStatus, title, body, at, item }
 *
 * The same order can appear several times (one entry per milestone), which is
 * what makes the feed readable instead of a single status that keeps changing.
 */
export function buildNotificationItems({ orders = [], uid = "", isAdmin = false, policy } = {}) {
  const resolved = policy?.events ? policy : resolvePolicy(policy);
  const items = new Map();

  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order || !order.id) continue;
    const status = String(order.status || "");

    for (const event of EVENT_CATALOG) {
      if (!event.statuses.includes(status)) continue;
      const settings = resolved.events[event.id];
      if (!settings || !settings.enabled) continue;
      if (resolved.audiences?.[event.audience] === false) continue;
      if (!audienceMatches(event, { order, uid, isAdmin })) continue;

      const key = `${event.id}:${order.id}`;
      if (items.has(key)) continue;

      const values = templateValues(order, event.audience);
      items.set(key, {
        key,
        eventId: event.id,
        audience: event.audience,
        orderId: order.id,
        orderStatus: status,
        item: values.item,
        title: renderTemplate(settings.title, values),
        body: renderTemplate(settings.body, values),
        at: timestampMs(order.updatedAt) || timestampMs(order.paidAt) ||
          timestampMs(order.createdAt) || Date.now()
      });
    }
  }

  return [...items.values()].sort((a, b) => b.at - a.at);
}

/** Items the reader has not seen yet. `readKeys` is an array or a Set. */
export function unreadItems(items, readKeys) {
  const seen = readKeys instanceof Set ? readKeys : new Set(readKeys || []);
  return (items || []).filter((item) => !seen.has(item.key));
}
