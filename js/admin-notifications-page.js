// Notification Admin — the administrator's side of js/notifications.js.
//
// The page is a thin form over settings/notifications. The catalogue of events
// comes from js/notification-policy.js, so adding an event there makes it
// appear here without touching this file. Firestore rules allow only an
// administrator to write settings/*, and the guard below mirrors that for the
// interface; the rules remain the real enforcement.

import { auth, onAuthStateChanged, firestoreErrorHtml } from "./firebase.js";
import { adminStatus, showAccessCheckFailure } from "./admin.js";
import {
  EVENT_CATALOG,
  AUDIENCE_LABEL,
  resolvePolicy,
  watchNotificationPolicy,
  saveNotificationPolicy,
  sendTestNotification
} from "./notifications.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let adminUser = null;
let savedPolicy = resolvePolicy(null);
let dirty = false;
let stopPolicy = null;

function message(text, kind = "info") {
  $("saveMsg").textContent = text || "";
  $("saveMsg").className = "chrome-note " + (text ? kind : "");
}

function eventCard(event, settings) {
  return `<article class="event-card${settings.enabled ? "" : " off"}" data-event="${esc(event.id)}">
    <div class="event-top">
      <input type="checkbox" data-enabled="${esc(event.id)}" ${settings.enabled ? "checked" : ""}
             aria-label="Enable ${esc(event.label)}">
      <div>
        <div class="who">${esc(AUDIENCE_LABEL[event.audience] || event.audience)}</div>
        <h3>${esc(event.label)}</h3>
        <p>${esc(event.hint)}</p>
      </div>
    </div>
    <div class="event-fields">
      <div class="field wide">
        <label for="title-${esc(event.id)}">Title</label>
        <input id="title-${esc(event.id)}" data-title="${esc(event.id)}" maxlength="80"
               value="${esc(settings.title)}" autocomplete="off">
      </div>
      <div class="field wide">
        <label for="body-${esc(event.id)}">Message</label>
        <textarea id="body-${esc(event.id)}" data-body="${esc(event.id)}" maxlength="300"
                  rows="2">${esc(settings.body)}</textarea>
        <p class="tokens">Placeholders: {orderId} {item} {total} {statusLabel} {buyer} {seller}</p>
      </div>
    </div>
  </article>`;
}

function render(policy) {
  $("channelInApp").checked = policy.channels.inApp;
  $("channelBrowser").checked = policy.channels.browser;
  $("channelSound").checked = policy.channels.sound;
  $("audienceBuyer").checked = policy.audiences.buyer;
  $("audienceSeller").checked = policy.audiences.seller;
  $("audienceAccount").checked = policy.audiences.account;
  $("audienceAdmin").checked = policy.audiences.admin;
  $("channelPhone").checked = policy.channels.phone;
  $("channelDigest").checked = policy.channels.digest;

  const audiences = ["buyer", "seller", "admin"];
  $("eventGroups").innerHTML = audiences.map((audience) => {
    const events = EVENT_CATALOG.filter((event) => event.audience === audience);
    if (!events.length) return "";
    const intro = {
      buyer: "Sent to the person who bought the item.",
      seller: "Sent to the seller who listed the item.",
      admin: "Sent to administrators only."
    }[audience];
    return `<section class="notif-group">
      <h2>${esc(AUDIENCE_LABEL[audience])} notifications</h2>
      <p class="hint">${esc(intro)}</p>
      ${events.map((event) => eventCard(event, policy.events[event.id])).join("")}
    </section>`;
  }).join("");
}

function readForm() {
  const events = {};
  for (const event of EVENT_CATALOG) {
    events[event.id] = {
      enabled: document.querySelector(`[data-enabled="${event.id}"]`)?.checked ?? true,
      title: (document.querySelector(`[data-title="${event.id}"]`)?.value || "").trim(),
      body: (document.querySelector(`[data-body="${event.id}"]`)?.value || "").trim()
    };
  }
  return {
    channels: {
      inApp: $("channelInApp").checked,
      browser: $("channelBrowser").checked,
      sound: $("channelSound").checked,
      phone: $("channelPhone").checked,
      digest: $("channelDigest").checked
    },
    audiences: {
      buyer: $("audienceBuyer").checked,
      seller: $("audienceSeller").checked,
      account: $("audienceAccount").checked,
      admin: $("audienceAdmin").checked
    },
    events
  };
}

function markDirty() {
  dirty = true;
  message("Unsaved changes.", "warn");
}

document.addEventListener("input", markDirty);
document.addEventListener("change", (event) => {
  const card = event.target.closest(".event-card");
  if (card && event.target.matches("[data-enabled]")) {
    card.classList.toggle("off", !event.target.checked);
  }
});

$("saveBtn").addEventListener("click", async () => {
  $("saveBtn").disabled = true;
  message("Saving…");
  try {
    const saved = await saveNotificationPolicy(readForm(), adminUser);
    savedPolicy = resolvePolicy(saved);
    dirty = false;
    message("Saved. Every open MailMart page picks this up immediately.", "good");
    render(savedPolicy);
  } catch (error) {
    console.error(error);
    message("Could not save: " + error.message, "bad");
  } finally {
    $("saveBtn").disabled = false;
  }
});

$("resetBtn").addEventListener("click", () => {
  const defaults = resolvePolicy(null);
  render(defaults);
  dirty = true;
  message("Defaults restored in the form. Save to publish them.", "warn");
});

$("testBtn").addEventListener("click", async () => {
  message("Sending a test…");
  try {
    const result = await sendTestNotification(readForm());
    if (result === "granted") message("Test sent. Check this device's notifications.", "good");
    else if (result === "denied") message("This browser has blocked notifications for the site. Allow them in the site settings first.", "bad");
    else if (result === "unsupported") message("This browser cannot show device alerts; the in-app bell still works.", "bad");
    else message("The browser did not grant permission, so only the in-app bell will show alerts.", "warn");
  } catch (error) {
    console.error(error);
    message("Test failed: " + error.message, "bad");
  }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "login.html"; return; }

  const access = await adminStatus(user);
  if (!access.isAdmin) {
    if (access.error) return showAccessCheckFailure(access.error);
    window.location.href = "dashboard.html";
    return;
  }

  adminUser = user;
  $("loadingScreen").style.display = "none";
  $("app").hidden = false;

  if (stopPolicy) stopPolicy();
  stopPolicy = watchNotificationPolicy((policy) => {
    savedPolicy = policy;
    // Never overwrite half-typed wording with a live update.
    if (!dirty) render(policy);
  }, (error) => {
    $("eventGroups").innerHTML = firestoreErrorHtml(error, "notification settings");
  });
});
