import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_CATALOG,
  ORDER_STATUS_LABEL,
  statusLabelFor,
  resolvePolicy,
  serializePolicy,
  buildNotificationItems,
  collectAlerts,
  buildDigest,
  DIGEST_LIMITS,
  recipientUidsFor,
  notificationKey,
  topicForUid,
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

function statusLabelForKind(event, status) {
  const kind = { order: "order", transaction: "transaction", kyc: "kyc" }[event.source] || event.collection;
  return statusLabelFor(kind, status);
}

function itemsFor(orders, { uid = BUYER, isAdmin = false, policy = resolvePolicy(null) } = {}) {
  return buildNotificationItems({ orders, uid, isAdmin, policy });
}

test("every catalogue event is valid and defaults are usable", () => {
  const ids = new Set();
  for (const event of EVENT_CATALOG) {
    assert.ok(!ids.has(event.id), "duplicate event id " + event.id);
    ids.add(event.id);
    assert.ok(["buyer", "seller", "account", "admin"].includes(event.audience), event.id);
    assert.ok(["order", "transaction", "service", "kyc"].includes(event.source), event.id);
    if (event.source === "service") assert.ok(["socialRequests", "rentals"].includes(event.collection), event.id);
    if (event.source === "transaction") assert.ok(Array.isArray(event.types) && event.types.length, event.id);
    assert.ok(event.statuses.length > 0, event.id);
    for (const status of event.statuses) {
      assert.ok(statusLabelForKind(event, status), event.id + " → " + status);
    }
    assert.ok(event.title.length <= 80, event.id);
    assert.ok(event.body.length <= 300, event.id);
    assert.match(event.label, /\S/);
  }
  const policy = resolvePolicy(null);
  for (const event of EVENT_CATALOG) {
    assert.deepEqual(policy.events[event.id], { enabled: true, title: event.title, body: event.body });
  }
  assert.deepEqual(policy.channels, {
    inApp: true, browser: true, sound: true, phone: true, digest: true
  });
  assert.deepEqual(policy.audiences, { buyer: true, seller: true, account: true, admin: true });
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
  assert.deepEqual(policy.audiences, { buyer: true, seller: false, account: true, admin: true });

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

const TX = (id, type, status, overrides = {}) => ({
  id, type, status, uid: BUYER, email: "buyer@example.com", amount: 5000,
  createdAt: stamp(1000), updatedAt: stamp(3000), ...overrides
});

test("wallet alerts reach the wallet owner only, and respect the ledger type", () => {
  const deposit = buildNotificationItems({
    uid: BUYER,
    transactions: [TX("t1", "deposit", "completed"), TX("t2", "deposit", "pending")]
  });
  assert.deepEqual(deposit.map((item) => item.eventId), ["wallet_deposit_approved"]);
  assert.equal(deposit[0].body, "Your deposit of ₦5,000.00 has been added to your MailMart wallet.");

  const mixed = buildNotificationItems({
    uid: BUYER,
    transactions: [
      TX("t3", "withdrawal", "completed"),
      TX("t4", "withdrawal", "rejected"),
      TX("t5", "order_payout", "completed"),
      TX("t6", "email_payout", "completed"),
      TX("t7", "order_refund", "completed"),
      TX("t8", "listing_fee", "completed"),
      TX("t9", "order_payment", "completed")
    ]
  });
  assert.deepEqual(mixed.map((item) => item.eventId).sort(), [
    "wallet_payout", "wallet_payout", "wallet_refund",
    "wallet_withdrawal_paid", "wallet_withdrawal_rejected"
  ]);

  const someoneElse = buildNotificationItems({ uid: "stranger", transactions: [TX("t1", "deposit", "completed")] });
  assert.deepEqual(someoneElse, []);
});

test("service requests and seller verification raise their own alerts", () => {
  const services = buildNotificationItems({
    uid: BUYER,
    services: [
      { id: "s1", _kind: "socialRequests", uid: BUYER, title: "Instagram page", status: "completed" },
      { id: "r1", _kind: "rentals", uid: BUYER, categoryName: "Registration code", status: "awaiting_code", amount: 50 },
      { id: "r2", _kind: "rentals", uid: "someone-else", categoryName: "Other", status: "completed" }
    ]
  });
  assert.deepEqual(services.map((item) => item.eventId).sort(), ["service_rental_update", "service_social_reviewed"]);
  const social = services.find((item) => item.eventId === "service_social_reviewed");
  assert.equal(social.body, "Your request “Instagram page” is now Completed.");
  const rental = services.find((item) => item.eventId === "service_rental_update");
  assert.equal(rental.title, "Email code Awaiting code");

  const kyc = buildNotificationItems({
    uid: SELLER,
    verifications: [
      { id: SELLER, uid: SELLER, status: "approved", fullName: "Ada" },
      { id: "other", uid: "other", status: "rejected" }
    ]
  });
  assert.deepEqual(kyc.map((item) => item.eventId), ["seller_verified"]);
  assert.equal(kyc[0].title, "Seller verification Approved");
});

test("collectAlerts fans administrator events out to every administrator once", () => {
  const alerts = collectAlerts({
    orders: [order("abc", "pending_payment")],
    adminUids: ["admin-1", "admin-2"]
  });
  const adminAlert = alerts.find((alert) => alert.eventId === "admin_placed");
  assert.deepEqual(adminAlert.recipientUids, ["admin-1", "admin-2"]);

  const twice = collectAlerts({ orders: [order("abc", "pending_payment")], adminUids: ["admin-1", "admin-1"] });
  assert.deepEqual(twice.filter((alert) => alert.eventId === "admin_placed").length, 1);

  assert.deepEqual(recipientUidsFor(EVENT_CATALOG.find((e) => e.id === "buyer_paid"), { buyerUid: "b" }), ["b"]);
  assert.deepEqual(recipientUidsFor(EVENT_CATALOG.find((e) => e.id === "seller_paid"), { sellerUid: "s" }), ["s"]);
  assert.deepEqual(recipientUidsFor(EVENT_CATALOG.find((e) => e.id === "seller_verified"), { uid: "s" }), ["s"]);
  assert.deepEqual(recipientUidsFor(EVENT_CATALOG.find((e) => e.id === "wallet_payout"), { uid: "u" }), ["u"]);
  assert.equal(notificationKey("buyer_paid", "order", "abc"), "buyer_paid:order:abc");
});

test("phone topics are unguessable enough and reject nonsense ids", () => {
  const topic = topicForUid("AbCdEfGh12345678xyz");
  assert.match(topic, /^mailmart-[a-z0-9]{8,20}$/);
  assert.notEqual(topicForUid("uid-one-123456"), topicForUid("uid-two-123456"));
  assert.throws(() => topicForUid("short"));
  assert.match(topicForUid("AbCdEfGh12345678xyz", "s4lt"), /-s4lt$/);
});

const alert = (index, at) => ({
  key: `buyer_paid:order:${index}`,
  title: `Alert ${index}`,
  body: `Body ${index}`,
  at
});

test("a lone alert keeps the administrator's exact wording", () => {
  const one = buildDigest([alert(1, 1000)]);
  assert.deepEqual(one, {
    title: "Alert 1",
    message: "Body 1",
    count: 1,
    keys: ["buyer_paid:order:1"],
    digest: false
  });
  assert.equal(buildDigest([]), null);
  assert.equal(buildDigest(null), null);
  assert.equal(buildDigest([{ title: "no key" }]), null);
});

test("several alerts become one digest, newest first, with every key marked", () => {
  const digest = buildDigest([alert(1, 1000), alert(2, 3000), alert(3, 2000)]);
  assert.equal(digest.title, "MailMart · 3 updates");
  assert.equal(digest.message, ["• Alert 2 — Body 2", "• Alert 3 — Body 3", "• Alert 1 — Body 1"].join("\n"));
  assert.equal(digest.count, 3);
  assert.equal(digest.digest, true);
  // Hidden or not, every folded-in alert is reported so none is re-sent.
  assert.deepEqual(digest.keys.sort(), [
    "buyer_paid:order:1", "buyer_paid:order:2", "buyer_paid:order:3"
  ]);
});

test("a long batch is cut for length but still reports every key", () => {
  const many = Array.from({ length: 9 }, (_, index) => alert(index, 1000 + index));
  const digest = buildDigest(many);
  assert.equal(digest.title, "MailMart · 9 updates");
  assert.equal(digest.keys.length, 9, "all keys are reported even when lines are hidden");
  assert.match(digest.message, /…and 3 more updates\.$/);
  assert.equal(digest.message.split("\n").length, DIGEST_LIMITS.maxItems + 1);

  const long = buildDigest([
    { key: "a", title: "A", body: "x".repeat(4000), at: 2 },
    { key: "b", title: "B", body: "y".repeat(4000), at: 1 }
  ]);
  assert.ok(long.message.length <= DIGEST_LIMITS.maxChars, "message stays inside ntfy's 4 KB body");
  assert.match(long.message, /…$/);
  assert.deepEqual(long.keys, ["a", "b"]);

  const tiny = buildDigest(
    [{ key: "a", title: "A", body: "b", at: 2 }, { key: "b", title: "B", body: "c", at: 1 }],
    { maxChars: 12 }
  );
  assert.equal(tiny.message.length, 12);
  assert.deepEqual(tiny.keys, ["a", "b"]);
});

test("digest is on by default and the administrator can switch it off", () => {
  assert.equal(resolvePolicy(null).channels.digest, true);
  assert.equal(resolvePolicy({ channels: { digest: false } }).channels.digest, false);
  assert.equal(resolvePolicy({ channels: { digest: "no" } }).channels.digest, true);
  const round = serializePolicy({ channels: { digest: false } });
  assert.equal(round.channels.digest, false);
});
