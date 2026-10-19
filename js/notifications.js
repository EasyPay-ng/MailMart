// Notifications — the in-app centre and the device alerts behind it.
//
// There is no server in this repository, so "notifications" are built from the
// Firestore data a signed-in person is already allowed to read: their own
// orders (as buyer and seller, plus every order for an administrator). A page
// that mounts the bell keeps a live listener on those orders; when an order
// enters a status the administrator has enabled, a notification appears.
//
// What the administrator controls lives in settings/notifications:
//   channels.inApp    — show the bell and the feed at all
//   channels.browser  — allowed to raise a system (phone/desktop) alert
//   channels.sound    — play a short chime with a new alert
//   events.<id>       — enable/disable one event and rewrite its title/body
//
// What this can and cannot do:
//   • While a MailMart tab is open (even in the background), a notification is
//     raised through the Notification API and the service worker, so it lands
//     in the phone's notification shade like any other app.
//   • With every MailMart tab closed there is no process to notice the change.
//     Delivering that needs Firebase Cloud Messaging plus a Cloud Function that
//     writes on order changes (and an FCM token per device) — see the README
//     section "Notifications". Nothing here pretends otherwise.
//
// Read state is per browser, not per account: keys live in localStorage. That
// keeps this feature serverless; a cross-device read marker would need a small
// per-user document.

import {
  db,
  doc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  setDoc,
  deleteDoc,
  serverTimestamp
} from "./firebase.js";
import {
  EVENT_CATALOG,
  POLICY_DOC_PATH,
  ORDER_STATUS_LABEL,
  AUDIENCE_LABEL,
  SOURCE_LABEL,
  resolvePolicy,
  serializePolicy,
  buildNotificationItems,
  unreadItems,
  formatNaira,
  topicForUid,
  phoneAlertLink,
  phoneAlertDeepLink,
  isAppleMobile
} from "./notification-policy.js";

export {
  phoneAlertLink,
  phoneAlertDeepLink,
  isAppleMobile,
  EVENT_CATALOG,
  ORDER_STATUS_LABEL,
  AUDIENCE_LABEL,
  SOURCE_LABEL,
  resolvePolicy,
  serializePolicy,
  buildNotificationItems,
  unreadItems,
  formatNaira
};

export const POLICY_DOCUMENT = doc(db, POLICY_DOC_PATH[0], POLICY_DOC_PATH[1]);

const ICON = "https://res.cloudinary.com/wfcrf1ps/image/upload/f_auto,q_auto,w_128/v1786979320/WhatsApp_Image_2026-08-16_at_11.41.57_PM.jpg";
const STORAGE_NS = "mailmart.notifications.v1";
const MAX_STORED_KEYS = 400;
/** Events older than this are shown but do not pop a system alert. */
const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* the administrator's policy                                          */
/* ------------------------------------------------------------------ */

/** Live policy. Falls back to the defaults if the document cannot be read. */
export function watchNotificationPolicy(onPolicy, onError) {
  return onSnapshot(
    POLICY_DOCUMENT,
    (snap) => onPolicy(resolvePolicy(snap.exists() ? snap.data() : null)),
    (error) => {
      console.warn("Notification settings could not be read; using defaults:", error);
      onPolicy(resolvePolicy(null));
      if (onError) onError(error);
    }
  );
}

/** Administrator-only write (firestore.rules: settings write is isAdmin). */
export async function saveNotificationPolicy(policy, user) {
  const payload = serializePolicy(policy);
  await setDoc(POLICY_DOCUMENT, {
    ...payload,
    updatedBy: user?.email || "",
    updatedAt: serverTimestamp()
  });
  return payload;
}

/* ------------------------------------------------------------------ */
/* live order feeds the person is allowed to read                      */
/* ------------------------------------------------------------------ */

/**
 * Watch every record that can raise a notification for this user.
 *
 * Nothing is emitted until each listener has answered once, so the first
 * snapshot is complete. That matters: a partial first snapshot would make the
 * reader look like they had already seen half their feed, and the second half
 * would then alert as if it were new.
 *
 * Only collections the person's security rules already allow are opened:
 * their own orders, their own wallet ledger, their own service requests, their
 * own verification document — plus platform-wide orders and service requests
 * for an administrator.
 */
export function watchNotificationSources(user, { isAdmin = false } = {}, onSources, onError = console.error) {
  if (!user) return () => {};

  const state = {
    orders: [],
    transactions: [],
    services: [],
    verifications: []
  };
  const ready = new Set();
  const expected = ["buyer", "seller", "transactions", "socialRequests", "rentals", "kyc"];
  if (isAdmin) expected.push("allOrders", "allSocial", "allRentals");
  const stops = [];
  let stopped = false;

  const emit = () => {
    if (stopped) return;
    if (!expected.every((name) => ready.has(name))) return;
    onSources({ ...state, services: [...state.services] });
  };

  const subscribe = (name, buildQuery) => {
    let stop = () => {};
    try {
      stop = onSnapshot(
        buildQuery(),
        (snap) => {
          apply(name, snap);
          ready.add(name);
          emit();
        },
        (error) => {
          ready.add(name);
          onError(error);
          emit();
        }
      );
    } catch (error) {
      ready.add(name);
      onError(error);
      emit();
    }
    stops.push(() => stop());
  };

  const apply = (name, snap) => {
    const docs = typeof snap.docs?.map === "function"
      ? snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      : (snap.exists ? [{ id: snap.id, ...snap.data() }] : []);
    switch (name) {
      case "buyer": {
        const seen = new Set(docs.map((row) => row.id));
        state.orders = [...docs, ...state.orders.filter((row) => !seen.has(row.id))];
        break;
      }
      case "seller": {
        const byId = new Map(state.orders.map((row) => [row.id, row]));
        for (const row of docs) byId.set(row.id, row);
        state.orders = [...byId.values()];
        break;
      }
      case "allOrders": {
        const byId = new Map(state.orders.map((row) => [row.id, row]));
        for (const row of docs) byId.set(row.id, row);
        state.orders = [...byId.values()];
        break;
      }
      case "transactions":
        state.transactions = docs;
        break;
      case "socialRequests":
      case "allSocial":
        state.services = [
          ...state.services.filter((row) => row._kind !== "socialRequests"),
          ...docs.map((row) => ({ ...row, _kind: "socialRequests" }))
        ];
        break;
      case "rentals":
      case "allRentals":
        state.services = [
          ...state.services.filter((row) => row._kind !== "rentals"),
          ...docs.map((row) => ({ ...row, _kind: "rentals" }))
        ];
        break;
      case "kyc":
        state.verifications = docs;
        break;
      default:
        break;
    }
  };

  subscribe("buyer", () => query(
    collection(db, "orders"),
    where("buyerUid", "==", user.uid),
    orderBy("createdAt", "desc"),
    limit(100)
  ));

  subscribe("seller", () => query(
    collection(db, "orders"),
    where("sellerUid", "==", user.uid),
    orderBy("createdAt", "desc"),
    limit(100)
  ));

  subscribe("transactions", () => query(
    collection(db, "transactions"),
    where("uid", "==", user.uid),
    orderBy("createdAt", "desc"),
    limit(50)
  ));

  subscribe("socialRequests", () => query(
    collection(db, "socialRequests"),
    where("uid", "==", user.uid),
    orderBy("createdAt", "desc"),
    limit(30)
  ));

  subscribe("rentals", () => query(
    collection(db, "rentals"),
    where("uid", "==", user.uid),
    orderBy("createdAt", "desc"),
    limit(30)
  ));

  subscribe("kyc", () => doc(db, "kyc", user.uid));

  if (isAdmin) {
    subscribe("allOrders", () => query(
      collection(db, "orders"),
      orderBy("createdAt", "desc"),
      limit(100)
    ));
    subscribe("allSocial", () => query(
      collection(db, "socialRequests"),
      orderBy("createdAt", "desc"),
      limit(50)
    ));
    subscribe("allRentals", () => query(
      collection(db, "rentals"),
      orderBy("createdAt", "desc"),
      limit(50)
    ));
  }

  return () => {
    stopped = true;
    for (const stop of stops) {
      try { stop(); } catch { /* already closed */ }
    }
  };
}

/**
 * Backwards-compatible alias: earlier code (and the reference in the README)
 * talked about "the orders feed". The feed now covers more than orders.
 */
export const watchNotificationOrders = watchNotificationSources;

/* ------------------------------------------------------------------ */
/* phone alerts (free, delivered by the scheduled sender)              */
/* ------------------------------------------------------------------ */

export const NTFY_BASE = "https://ntfy.sh";

/** Where this account's phone alerts are registered, if they are. */
export function watchPhoneAlerts(user, onValue, onError = console.error) {
  if (!user) return () => {};
  return onSnapshot(
    doc(db, "pushSubscriptions", user.uid),
    (snap) => onValue(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError
  );
}

/**
 * Register (or re-register) this account's phone alert topic.
 *
 * The topic is a long random string, because ntfy has no accounts on the free
 * tier: knowing the topic is what lets a device subscribe. It is stored on a
 * document only this account (and administrators) may read.
 */
export async function enablePhoneAlerts(user, { base = NTFY_BASE, topic } = {}) {
  if (!user) throw new Error("Sign in first.");
  const value = topic || topicForUid(user.uid, Math.random().toString(36).slice(2, 10));
  await setDoc(doc(db, "pushSubscriptions", user.uid), {
    topic: value,
    ntfyBase: base,
    enabled: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });
  return value;
}

/** Keep the topic but stop sending to it. */
export async function pausePhoneAlerts(user) {
  if (!user) throw new Error("Sign in first.");
  await setDoc(doc(db, "pushSubscriptions", user.uid), {
    enabled: false,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

/** Remove the registration entirely. */
export async function disablePhoneAlerts(user) {
  if (!user) throw new Error("Sign in first.");
  await deleteDoc(doc(db, "pushSubscriptions", user.uid));
}

/*
 * The `phoneAlert*` helpers and `isAppleMobile` live in notification-policy.js
 * because they are pure; they are re-exported with the block below so pages
 * only ever import from this module.
 */

/* ------------------------------------------------------------------ */
/* per-browser state                                                   */
/* ------------------------------------------------------------------ */

function storageGet(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
}

function loadKeySet(kind, uid) {
  const raw = storageGet(`${STORAGE_NS}.${kind}.${uid}`, "[]");
  try {
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

function saveKeySet(kind, uid, keys) {
  const list = [...keys].slice(-MAX_STORED_KEYS);
  storageSet(`${STORAGE_NS}.${kind}.${uid}`, JSON.stringify(list));
}

function remember(set, value) {
  set.add(value);
  while (set.size > MAX_STORED_KEYS) set.delete(set.values().next().value);
}

/* ------------------------------------------------------------------ */
/* device permission and alerts                                        */
/* ------------------------------------------------------------------ */

export function notificationSupport() {
  if (typeof window === "undefined") return "unsupported";
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

export async function requestNotificationPermission() {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Register the tiny click handler worker. Safe to call repeatedly. */
export async function registerNotificationWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("sw.js");
  } catch (error) {
    console.warn("Service worker for notifications is unavailable:", error);
    return null;
  }
}

/** Two-tone chime, Web Audio only. Never a requirement. */
export function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 1180].forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const at = ctx.currentTime + index * 0.16;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.start(at);
      osc.stop(at + 0.2);
    });
    setTimeout(() => ctx.close(), 900);
  } catch {
    /* audio is a nicety, never a requirement */
  }
}

async function showDeviceNotification(item) {
  if (typeof window === "undefined" || !("Notification" in window)) return false;
  if (Notification.permission !== "granted") return false;
  const options = {
    body: item.body,
    tag: item.key,
    icon: ICON,
    badge: ICON,
    data: { url: "orders.html" }
  };
  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration && typeof registration.showNotification === "function") {
        await registration.showNotification(item.title, options);
        return true;
      }
    }
    new Notification(item.title, options);
    return true;
  } catch {
    // Android Chrome refuses `new Notification` and needs the service worker;
    // if neither worked, the in-app feed still shows the event.
    return false;
  }
}

/** Raise one alert for the current user; used by the admin "Test" button. */
export async function sendTestNotification(policy) {
  const resolved = resolvePolicy(policy);
  const permission = await requestNotificationPermission();
  if (permission !== "granted") return permission;
  await registerNotificationWorker();
  const sample = {
    key: "test:" + Date.now(),
    title: resolved.events.buyer_shipped.title,
    body: resolved.events.buyer_shipped.body
      .replace("{orderId}", "#MM12345")
      .replace("{statusLabel}", "Dispatched")
      .replace("{item}", "your item")
      .replace("{total}", formatNaira(0))
  };
  await showDeviceNotification(sample);
  if (resolved.channels.sound) playChime();
  return "granted";
}

/* ------------------------------------------------------------------ */
/* the bell                                                            */
/* ------------------------------------------------------------------ */

const CSS = `
#mmNotifRoot{position:fixed;right:18px;bottom:18px;z-index:9000;font-family:Inter,Arial,sans-serif}
.mm-bell-btn{position:relative;width:54px;height:54px;border-radius:50%;border:1px solid #dbe7f5;
  background:#fff;color:#142b4d;font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center;
  box-shadow:0 10px 26px rgba(21,69,137,.20);cursor:pointer;transition:transform .18s ease,box-shadow .18s ease}
.mm-bell-btn:hover{transform:translateY(-2px);box-shadow:0 14px 32px rgba(21,69,137,.26)}
.mm-bell-btn:focus-visible{outline:3px solid #0867e8;outline-offset:2px}
.mm-bell-btn svg{width:23px;height:23px;stroke:#142b4d}
.mm-bell-count{position:absolute;top:-3px;right:-3px;min-width:21px;height:21px;padding:0 5px;border-radius:11px;
  background:#e0353f;color:#fff !important;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;
  border:2px solid #fff}
.mm-bell-count[hidden]{display:none}
.mm-bell-panel{position:absolute;right:0;bottom:64px;width:min(390px,calc(100vw - 24px));max-height:min(72vh,580px);
  display:flex;flex-direction:column;background:#fff;color:#142b4d;border:1px solid #dbe7f5;border-radius:18px;
  box-shadow:0 24px 60px rgba(12,40,84,.28);overflow:hidden}
.mm-bell-panel[hidden]{display:none}
.mm-bell-panel.at-trigger{position:fixed;top:78px;right:18px;bottom:auto}
.mm-has-bell{position:relative}
.mm-has-bell .mm-bell-count{top:-6px;right:-6px}
.mm-bell-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;
  border-bottom:1px solid #eaf1fa;background:#f7fbff}
.mm-bell-head h3{font-size:14px;font-weight:800;color:#142b4d !important;margin:0}
.mm-bell-head button{border:0;background:transparent;color:#506783 !important;font:inherit;font-size:11.5px;font-weight:700;
  cursor:pointer;padding:4px 6px;border-radius:7px}
.mm-bell-head button:hover{background:#e7f1ff;color:#0867e8 !important}
.mm-bell-close{font-size:16px !important;line-height:1;padding:2px 7px !important}
.mm-bell-list{overflow-y:auto;flex:1;overscroll-behavior:contain}
.mm-bell-item{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid #eef4fb;background:#fff;
  padding:12px 16px;font:inherit;cursor:pointer;color:#142b4d}
.mm-bell-item:hover{background:#f5faff}
.mm-bell-item.unread{background:#edf6ff}
.mm-bell-item.unread:hover{background:#e3f1ff}
.mm-bell-item h4{margin:0 0 3px;font-size:12.8px;font-weight:800;color:#142b4d !important;display:flex;gap:6px;align-items:center}
.mm-bell-item p{margin:0;font-size:12px;line-height:1.55;color:#506783 !important}
.mm-bell-item time{display:block;margin-top:5px;font-size:10.5px;font-weight:700;color:#8195ad !important;letter-spacing:.2px}
.mm-bell-dot{width:7px;height:7px;border-radius:50%;background:#0867e8;flex-shrink:0}
.mm-bell-empty{padding:26px 18px;text-align:center;color:#6e8098 !important;font-size:12.5px;line-height:1.6}
.mm-bell-foot{border-top:1px solid #eaf1fa;background:#f7fbff;padding:10px 14px;display:flex;flex-wrap:wrap;
  gap:8px;align-items:center;justify-content:space-between}
.mm-bell-foot button,.mm-bell-foot a{font:inherit;font-size:11.5px;font-weight:800;text-decoration:none;
  border-radius:9px;padding:8px 12px;cursor:pointer}
.mm-bell-foot .mm-enable{background:#0867e8;color:#fff !important;border:1px solid #0867e8}
.mm-bell-foot .mm-enable:hover{background:#0753b8}
.mm-bell-foot .mm-admin{background:#fff;color:#0867e8 !important;border:1px solid #cfe0f4}
.mm-bell-foot .mm-note{font-size:10.5px;color:#6e8098 !important;line-height:1.5;width:100%;margin:0}
@media (max-width:640px){
  #mmNotifRoot{right:12px;bottom:12px}
  .mm-bell-panel,.mm-bell-panel.at-trigger{position:fixed;left:10px;right:10px;top:auto;bottom:78px;width:auto;max-height:68vh}
}
@media (prefers-reduced-motion:reduce){ .mm-bell-btn{transition:none} }
`;

function injectStyles() {
  if (document.getElementById("mmNotifStyles")) return;
  const style = document.createElement("style");
  style.id = "mmNotifStyles";
  style.textContent = CSS;
  document.head.appendChild(style);
}

function relativeTime(ms) {
  const delta = Date.now() - Number(ms || 0);
  if (!Number.isFinite(delta) || delta < 0) return "now";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 7) return days + "d ago";
  return new Date(ms).toLocaleDateString();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function createRoot() {
  const root = document.createElement("div");
  root.id = "mmNotifRoot";
  root.innerHTML = `
    <div class="mm-bell-panel" id="mmNotifPanel" role="dialog" aria-label="Notifications" hidden>
      <div class="mm-bell-head">
        <h3>Notifications</h3>
        <div style="display:flex;gap:2px">
          <button type="button" id="mmBellReadAll">Mark all read</button>
          <button type="button" class="mm-bell-close" id="mmBellClose" aria-label="Close notifications">&#10005;</button>
        </div>
      </div>
      <div class="mm-bell-list" id="mmBellList"></div>
      <div class="mm-bell-foot" id="mmBellFoot"></div>
    </div>
    <button type="button" class="mm-bell-btn" id="mmBellBtn" aria-label="Notifications" aria-expanded="false" aria-controls="mmNotifPanel">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>
      </svg>
      <span class="mm-bell-count" id="mmBellCount" hidden>0</span>
    </button>`;
  document.body.appendChild(root);
  return root;
}

/**
 * Add the notification bell to the current page.
 *
 * Call after authentication for a signed-in user. Returns { stop, open, close }.
 * The bell is deliberately self-contained: one style tag, one element, no CSS
 * edits on the pages that host it.
 */
export function mountNotificationBell(user, { isAdmin = false, trigger = null } = {}) {
  if (!user || typeof document === "undefined") return { stop() {}, open() {}, close() {} };

  injectStyles();
  const root = document.getElementById("mmNotifRoot") || createRoot();
  const button = root.querySelector("#mmBellBtn");
  const panel = root.querySelector("#mmNotifPanel");
  // A page with its own bell button (the dashboard top bar) passes it in;
  // then the floating bubble is hidden and the existing button is reused.
  const opener = trigger && !trigger.querySelector("#mmBellCount") ? trigger : button;
  const list = root.querySelector("#mmBellList");
  const foot = root.querySelector("#mmBellFoot");
  let count = root.querySelector("#mmBellCount");

  const state = {
    policy: resolvePolicy(null),
    sources: { orders: [], transactions: [], services: [], verifications: [] },
    items: [],
    read: loadKeySet("read", user.uid),
    alerted: loadKeySet("alerted", user.uid),
    seeded: storageGet(`${STORAGE_NS}.seeded.${user.uid}`, "") === "1",
    ordersReady: false,
    open: false
  };

  const stops = [];

  if (opener !== button) {
    button.hidden = true;
    opener.classList.add("mm-has-bell");
    opener.appendChild(count);
    opener.setAttribute("aria-controls", "mmNotifPanel");
    opener.setAttribute("aria-haspopup", "dialog");
    panel.classList.add("at-trigger");
    if (opener.tagName === "BUTTON") {
      opener.setAttribute("type", "button");
      if (!opener.getAttribute("aria-label")) opener.setAttribute("aria-label", "Notifications");
    }
  }

  const renderFoot = () => {
    const parts = [];
    // Re-read every render: permission can change in browser settings while
    // the page is open, and "denied" is not sticky inside one tab.
    state.permission = notificationSupport();
    if (state.permission === "default") {
      parts.push('<button type="button" class="mm-enable" id="mmBellEnable">Enable device alerts</button>');
    } else if (state.permission === "granted") {
      parts.push('<span class="mm-note" style="width:auto">Device alerts are on for this browser.</span>');
    } else if (state.permission === "denied") {
      parts.push('<span class="mm-note" style="width:auto">Device alerts are blocked in this browser’s site settings.</span>');
    } else {
      parts.push('<span class="mm-note" style="width:auto">This browser cannot show device alerts; the bell still works.</span>');
    }
    if (isAdmin) parts.push('<a class="mm-admin" href="admin-notifications.html">Admin settings</a>');
    if (state.policy.channels.phone) parts.push('<a class="mm-admin" href="dashboard.html#phone-alerts">Phone alerts</a>');
    parts.push('<p class="mm-note">Administrators choose which events appear here. Phone alerts keep arriving with MailMart closed — set them up under Dashboard → Phone alerts.</p>');
    foot.innerHTML = parts.join("");
    const enable = foot.querySelector("#mmBellEnable");
    if (enable) enable.addEventListener("click", async () => {
      state.permission = await requestNotificationPermission();
      if (state.permission === "granted") {
        await registerNotificationWorker();
        if (state.policy.channels.sound) playChime();
      }
      renderFoot();
    });
  };

  const renderList = () => {
    if (!state.items.length) {
      list.innerHTML = '<div class="mm-bell-empty">Nothing yet. Order updates and payment confirmations chosen by MailMart will appear here.</div>';
      return;
    }
    list.innerHTML = state.items.slice(0, 60).map((item) => {
      const unread = !state.read.has(item.key);
      return `<button type="button" class="mm-bell-item${unread ? " unread" : ""}" data-key="${escapeHtml(item.key)}">
        <h4>${unread ? '<span class="mm-bell-dot" aria-hidden="true"></span>' : ""}${escapeHtml(item.title)}</h4>
        <p>${escapeHtml(item.body)}</p>
        <time datetime="${new Date(item.at).toISOString()}">${escapeHtml(relativeTime(item.at))} · ${escapeHtml(AUDIENCE_LABEL[item.audience] || "")}</time>
      </button>`;
    }).join("");
  };

  const render = () => {
    const unread = unreadItems(state.items, state.read).length;
    count.textContent = unread > 99 ? "99+" : String(unread);
    count.hidden = unread === 0;
    opener.setAttribute("aria-label", unread ? `Notifications (${unread} unread)` : "Notifications");
    if (!state.policy.channels.inApp) {
      root.hidden = true;
      opener.hidden = true;
      return;
    }
    root.hidden = false;
    opener.hidden = false;
    renderList();
    renderFoot();
  };

  const persist = () => {
    saveKeySet("read", user.uid, state.read);
    saveKeySet("alerted", user.uid, state.alerted);
    storageSet(`${STORAGE_NS}.seeded.${user.uid}`, "1");
  };

  const alertNew = async (items) => {
    // Two open tabs share localStorage but not memory. Re-read the alerted
    // keys first, otherwise both tabs pop the same notification.
    state.alerted = loadKeySet("alerted", user.uid);
    const fresh = items.filter((item) => !state.alerted.has(item.key));
    if (!fresh.length) return;
    for (const item of fresh) remember(state.alerted, item.key);
    persist();

    const recent = fresh.filter((item) => Date.now() - item.at <= ALERT_WINDOW_MS);
    if (!recent.length) return;

    if (state.policy.channels.browser && notificationSupport() === "granted") {
      await registerNotificationWorker();
      let shown = 0;
      for (const item of recent.slice(0, 3)) {
        if (await showDeviceNotification(item)) shown += 1;
      }
      if (shown && state.policy.channels.sound) playChime();
    }
  };

  const recompute = ({ alert = false } = {}) => {
    state.items = buildNotificationItems({
      ...state.sources,
      uid: user.uid,
      isAdmin,
      policy: state.policy
    });

    if (!state.seeded) {
      // Wait for the real order snapshot before deciding this browser has
      // "seen" the feed; the policy document alone arrives first and would
      // otherwise seed an empty feed and alert on every existing order.
      if (!state.ordersReady) {
        render();
        return;
      }
      // First run on this browser: everything that already happened is part of
      // the feed, but it is not "new" and must not fire a wall of alerts.
      for (const item of state.items) {
        state.read.add(item.key);
        state.alerted.add(item.key);
      }
      state.seeded = true;
      persist();
    } else if (alert) {
      alertNew(state.items).catch((error) => console.warn("Notification alert failed:", error));
    }

    render();
  };

  const close = () => {
    state.open = false;
    panel.hidden = true;
    opener.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    state.open = true;
    panel.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    renderList();
  };

  opener.addEventListener("click", () => (state.open ? close() : open()));
  root.querySelector("#mmBellClose").addEventListener("click", close);
  root.querySelector("#mmBellReadAll").addEventListener("click", () => {
    for (const item of state.items) state.read.add(item.key);
    persist();
    render();
  });
  list.addEventListener("click", (event) => {
    const row = event.target.closest(".mm-bell-item");
    if (!row) return;
    state.read.add(row.dataset.key);
    persist();
    render();
    close();
    window.location.href = "orders.html";
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.open) close();
  });
  document.addEventListener("click", (event) => {
    if (!state.open) return;
    if (root.contains(event.target) || opener.contains(event.target)) return;
    close();
  });

  stops.push(watchNotificationPolicy(
    (policy) => {
      state.policy = policy;
      recompute({ alert: false });
    },
    (error) => console.warn("Notification policy:", error)
  ));

  stops.push(watchNotificationSources(user, { isAdmin }, (sources) => {
    state.sources = sources;
    state.ordersReady = true;
    recompute({ alert: state.seeded });
  }, (error) => console.warn("Notification feed:", error)));

  registerNotificationWorker();
  render();

  return {
    stop() {
      for (const stop of stops) {
        try { stop(); } catch { /* already closed */ }
      }
      close();
    },
    open,
    close
  };
}

/**
 * Convenience for pages that already resolved administrator status: mount the
 * bell and stop it when the signed-in user changes or signs out.
 */
export function startNotificationsForSession(user, { isAdmin = false, trigger = null } = {}) {
  return mountNotificationBell(user, { isAdmin, trigger });
}
