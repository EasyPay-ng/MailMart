import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_CATALOG,
  ORDER_STATUS_LABEL,
  resolvePolicy,
  serializePolicy,
  buildNotificationItems,
  unreadItems,
  renderTemplate,
  formatNaira,
  orderReference,
  timestampMs
} from "../js/notification-policy.js";

const BUYER = "buyer-uid";
const SELLER = "seller-uid";

function stamp(ms) {
  return { toMillis: () => ms, toDate: () => new Date(ms) };
}

function order(id, status, overrides = {}) {
  return {
    id,
    buyerUid: BUYER,
    sellerUid: SELLER,
    buyerEmail: "buyer@example.com",
    sellerEmail: "seller@example.com",
    listingTitle: "iPhone 13",
    total: 250000,
    status,
    createdAt: stamp(1000),
    updatedAt: stamp(2000),
    ...overrides
  };
}

function itemsFor(orders, { uid = BUYER, isAdmin = false, policy = resolvePolicy(null) } = {}) {
  return buildNotificationItems({ orders, uid, isAdmin, policy });
}

test("every catalogue event is valid and defaults are usable", () => {
  const ids = new Set();
  for (const event of EVENT_CATALOG) {
    assert.ok(!ids.has(event.id), "duplicate event id " + event.id);
    ids.add(event.id);
    assert.ok(["buyer", "seller", "admin"].includes(event.audience), event.id);
    assert.ok(event.statuses.length > 0, event.id);
    for (const status of event.statuses) assert.ok(ORDER_STATUS_LABEL[status], event.id + " → " + status);
    assert.ok(event.title.length <= 80, event.id);
    assert.ok(event.body.length <= 300, event.id);
    assert.match(event.label, /\S/);
  }
  const policy = resolvePolicy(null);
  for (const event of EVENT_CATALOG) {
    assert.deepEqual(policy.events[event.id], { enabled: true, title: event.title, body: event.body });
  }
  assert.deepEqual(policy.channels, { inApp: true, browser: true, sound: true });
  assert.deepEqual(policy.audiences, { buyer: true, seller: true, admin: true });
});

test("a stored policy overrides defaults field by field and drops rubbish", () => {
  const policy = resolvePolicy({
    channels: { browser: false, sound: "yes" },
    audiences: { seller: false },
    events: {
      buyer_shipped: { enabled: false, title: "  Parcel on the way  ", body: "" },
      buyer_paid: { title: "x".repeat(200) },
      not_an_event: { enabled: false, title: "nope" }
    },
    junk: true
  });

  assert.equal(policy.channels.browser, false);
  assert.equal(policy.channels.inApp, true, "missing channel keeps the default");
  assert.equal(policy.channels.sound, true, "non-boolean channel keeps the default");
  assert.deepEqual(policy.audiences, { buyer: true, seller: false, admin: true });

  assert.deepEqual(policy.events.buyer_shipped, {
    enabled: false,
    title: "Parcel on the way",
    body: EVENT_CATALOG.find((event) => event.id === "buyer_shipped").body
  });
  assert.equal(policy.events.buyer_paid.enabled, true);
  assert.equal(policy.events.buyer_paid.title.length, 80, "titles are capped");
  assert.equal(policy.events.buyer_paid.body, EVENT_CATALOG.find((event) => event.id === "buyer_paid").body);
  assert.equal(policy.events.not_an_event, undefined);

  const round = serializePolicy(policy);
  assert.deepEqual(serializePolicy(round), round);
  assert.equal(round.version, 1);
});

test("a buyer sees their own milestones, and only those", () => {
  const shipped = itemsFor([order("ord123456789", "shipped")]);
  assert.equal(shipped.length, 1);
  assert.equal(shipped[0].eventId, "buyer_shipped");
  assert.equal(shipped[0].title, "Order Update");
  assert.equal(shipped[0].body, "Your order #ORD12345 has been dispatched! Track your order in your dashboard.");
  assert.equal(shipped[0].orderId, "ord123456789");
  assert.equal(shipped[0].at, 2000);

  const ids = itemsFor([
    order("a", "paid"), order("b", "shipped"), order("c", "completed"),
    order("d", "cancelled"), order("e", "refunded"), order("f", "pending_payment")
  ]).map((item) => item.eventId).sort();
  assert.deepEqual(ids, [
    "buyer_cancelled", "buyer_cancelled", "buyer_completed",
    "buyer_paid", "buyer_placed", "buyer_shipped"
  ]);

  // The seller's and administrator's events never leak to the buyer.
  const all = itemsFor([order("a", "pending_payment"), order("b", "paid")]);
  assert.ok(all.every((item) => item.audience === "buyer"));
});

test("seller and administrator audiences are separate", () => {
  const seller = itemsFor(
    [order("a", "pending_payment"), order("b", "paid"), order("c", "completed")],
    { uid: SELLER }
  );
  assert.deepEqual(seller.map((item) => item.eventId).sort(), ["seller_completed", "seller_paid", "seller_placed"]);
  assert.equal(seller.find((item) => item.eventId === "seller_placed").body.includes("iPhone 13"), true);

  const admin = itemsFor([order("a", "pending_payment"), order("b", "paid")], { uid: "admin", isAdmin: true });
  assert.deepEqual(admin.map((item) => item.eventId), ["admin_placed"]);
  assert.match(admin[0].body, /₦250,000\.00/);

  const adminWhoBuys = buildNotificationItems({
    orders: [order("a", "shipped")], uid: BUYER, isAdmin: true, policy: resolvePolicy(null)
  });
  assert.deepEqual(adminWhoBuys.map((item) => item.eventId), ["buyer_shipped"]);
});

test("the administrator's switches and wording are obeyed exactly", () => {
  const policy = resolvePolicy({
    events: {
      buyer_shipped: {
        enabled: false,
        title: "Should not appear",
        body: "Should not appear"
      },
      buyer_paid: {
        enabled: true,
        title: "Money received",
        body: "We have {orderId} for {total}. Thanks {buyer}."
      }
    }
  });

  const items = itemsFor([order("abc", "shipped"), order("def", "paid")], { policy });
  assert.deepEqual(items.map((item) => item.eventId), ["buyer_paid"]);
  assert.equal(items[0].title, "Money received");
  assert.equal(items[0].body, "We have #DEF for ₦250,000.00. Thanks buyer@example.com.");

  const noBuyers = resolvePolicy({ audiences: { buyer: false } });
  assert.deepEqual(itemsFor([order("abc", "paid")], { policy: noBuyers }), [],
    "the buyer master switch silences buyer events");
  assert.deepEqual(
    itemsFor([order("abc", "paid")], { uid: SELLER, isAdmin: false, policy: noBuyers }).map((item) => item.eventId),
    ["seller_paid"],
    "the seller still hears about their own sale; buyer events stay silent"
  );
  assert.equal(itemsFor([order("abc", "pending_payment")], { uid: "admin", isAdmin: true, policy: noBuyers }).length, 1,
    "other audiences are unaffected");

  const noChannels = resolvePolicy({ channels: { inApp: false } });
  assert.equal(noChannels.channels.inApp, false);
  assert.ok(itemsFor([order("abc", "paid")], { policy: noChannels }).length === 1,
    "the policy layer always returns items; channels gate the UI, not the data");
});

test("feed is newest-first, de-duplicated, and tolerant of sparse orders", () => {
  const items = itemsFor([
    order("old", "paid", { updatedAt: stamp(1000) }),
    order("new", "shipped", { updatedAt: stamp(9000) }),
    order("new", "shipped", { updatedAt: stamp(9000) })
  ]);
  assert.deepEqual(items.map((item) => item.orderId), ["new", "old"]);

  assert.deepEqual(itemsFor(null), []);
  assert.deepEqual(itemsFor([null, {}, { id: "x" }]), []);
  assert.equal(orderReference({ id: "abcdef123456" }), "#ABCDEF12");
  assert.equal(orderReference({ id: "x", orderNumber: "MM12345" }), "#MM12345");
  assert.equal(timestampMs(null), 0);
  assert.equal(timestampMs("not a date"), 0);
});

test("templates, money and unread helper behave predictably", () => {
  assert.equal(renderTemplate("{a}-{b}-{c}", { a: 1, b: "two" }), "1-two-{c}");
  assert.equal(formatNaira(250000), "₦250,000.00");
  assert.equal(formatNaira(1234.5), "₦1,234.50");
  assert.equal(formatNaira("nonsense"), "₦0.00");

  const items = [{ key: "one" }, { key: "two" }];
  assert.deepEqual(unreadItems(items, ["one"]).map((item) => item.key), ["two"]);
  assert.deepEqual(unreadItems(items, new Set(["one", "two"])), []);
  assert.equal(unreadItems(items, []).length, 2);
});
