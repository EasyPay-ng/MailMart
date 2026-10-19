// Phone alerts — the free, closed-app delivery path.
//
// Nothing here talks to ntfy directly. Enabling alerts only registers a topic
// on pushSubscriptions/{uid}; the scheduled sender (scripts/notify-worker.mjs,
// run by .github/workflows/notify-cron.yml) reads that document and posts the
// message to ntfy, which pushes it to the ntfy app on the phone.
//
// Doing it this way has three consequences worth knowing:
//   • No secret lives in the browser: the sender holds the Firebase credential,
//     and ntfy needs none.
//   • Alerts arrive with MailMart closed, because GitHub's runner is awake
//     every five minutes whether or not the customer is.
//   • Delivery is not instant. Five minutes is the floor for GitHub schedules,
//     and a busy GitHub can delay a run further.

import { db, doc, onSnapshot, setDoc, serverTimestamp } from "./firebase.js";
import { topicForUid, resolvePolicy, POLICY_DOC_PATH } from "./notification-policy.js";
import { phoneAlertLink, NTFY_BASE } from "./notifications.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function randomSalt() {
  try {
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(36)).join("").slice(0, 10);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Render the phone-alert card into `container` and keep it in step with the
 * stored subscription.
 */
export function mountPhoneAlerts(user, container) {
  if (!container || !user) return { stop() {} };

  let stop = () => {};
  let stopPolicy = () => {};
  let current = null;
  let channelEnabled = true;
  let busy = false;

  const render = (subscription) => {
    current = subscription;
    if (!channelEnabled) {
      container.innerHTML = `<div class="kv"><span>Status</span><b>Unavailable</b></div>
        <p class="msg">MailMart has switched phone alerts off for everyone right now. The in-app bell still works.</p>`;
      return;
    }
    const active = subscription && subscription.enabled === true;
    const topic = subscription?.topic || "";
    const base = subscription?.ntfyBase || NTFY_BASE;
    const link = topic ? phoneAlertLink(topic, base) : "";

    container.innerHTML = `
      <div class="kv"><span>Status</span><b>${active ? "On — this phone can receive alerts" : "Off"}</b></div>
      ${topic ? `<div class="kv"><span>Alert topic</span><b style="font-family:ui-monospace,Menlo,monospace;font-size:11.5px">${esc(topic)}</b></div>` : ""}
      <div class="msg" id="phoneAlertMsg"></div>
      <div class="wallet-actions">
        <button class="btn-fill" type="button" id="phoneAlertsToggle" ${busy ? "disabled" : ""}>
          ${active ? "Turn phone alerts off" : (topic ? "Turn phone alerts back on" : "Turn on phone alerts")}
        </button>
        ${topic ? '<button class="btn-ghost" type="button" id="phoneAlertsCopy">Copy topic</button>' : ""}
        ${topic ? `<a class="btn-ghost" href="${esc(link)}" target="_blank" rel="noopener" style="text-align:center">Open ntfy</a>` : ""}
      </div>
      <p class="msg">
        Install the free <b>ntfy</b> app (Android, iPhone or desktop), choose
        <b>Subscribe to topic</b>, and paste the topic above. Alerts then arrive with
        MailMart closed. They are sent every few minutes rather than instantly, and
        the topic is the password: anyone who learns it can read these alerts, so
        rotate it here if that ever matters.
      </p>`;

    const toggle = container.querySelector("#phoneAlertsToggle");
    if (toggle) toggle.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      const note = container.querySelector("#phoneAlertMsg");
      toggle.disabled = true;
      try {
        if (active) {
          await setDoc(doc(db, "pushSubscriptions", user.uid), {
            enabled: false, updatedAt: serverTimestamp()
          }, { merge: true });
          note.className = "msg info";
          note.textContent = "Phone alerts are off. The topic is kept so you can turn them back on.";
        } else {
          const value = topic || topicForUid(user.uid, randomSalt());
          await setDoc(doc(db, "pushSubscriptions", user.uid), {
            topic: value, ntfyBase: base, enabled: true,
            createdAt: serverTimestamp(), updatedAt: serverTimestamp()
          }, { merge: true });
          note.className = "msg good";
          note.textContent = "Phone alerts are on. Subscribe to this topic in the ntfy app.";
        }
      } catch (error) {
        note.className = "msg bad";
        note.textContent = "Could not save: " + error.message;
      } finally {
        busy = false;
      }
    });

    const copy = container.querySelector("#phoneAlertsCopy");
    if (copy) copy.addEventListener("click", async () => {
      const note = container.querySelector("#phoneAlertMsg");
      const ok = await copyText(topic);
      note.className = ok ? "msg good" : "msg bad";
      note.textContent = ok
        ? "Topic copied."
        : "Copying is blocked here — select the topic above and copy it by hand.";
    });
  };

  render(null);

  // An administrator can switch the whole channel off; the card should say so
  // rather than offer a button that will never deliver anything.
  stopPolicy = onSnapshot(
    doc(db, POLICY_DOC_PATH[0], POLICY_DOC_PATH[1]),
    (snap) => {
      channelEnabled = resolvePolicy(snap.exists() ? snap.data() : null).channels.phone;
      render(current);
    },
    () => { /* defaults: phone alerts available */ }
  );

  stop = onSnapshot(
    doc(db, "pushSubscriptions", user.uid),
    (snap) => render(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    (error) => {
      container.innerHTML = `<div class="msg bad">Phone alerts could not be read (${esc(error.code || "error")}). The Firestore rules must be deployed for this feature.</div>`;
    }
  );

  return {
    stop() {
      for (const unsubscribe of [stop, stopPolicy]) {
        try { unsubscribe(); } catch { /* already closed */ }
      }
    }
  };
}
