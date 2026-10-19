// Phone-alert sender.
//
// Run by .github/workflows/notify-cron.yml every five minutes. It is the only
// piece of MailMart that runs with server privileges, and it exists because a
// static site cannot notice anything while nobody has a tab open.
//
// What it does, in order:
//   1. Reads settings/notifications — the administrator's policy.
//   2. Finds records updated since the last look-back window (orders, wallet
//      ledger rows, service requests, seller verification).
//   3. Folds them through js/notification-policy.js, the same pure module the
//      in-app bell uses, so the two can never disagree about what happened.
//   4. Resolves each alert's recipients and keeps only those who opted into
//      phone alerts (pushSubscriptions/{uid}) and have not already been told.
//   5. Groups what is left by person and posts ONE message each — a single
//      alert keeps its exact wording, several become a short digest. That is
//      what keeps a busy day inside the free 250-messages-a-day allowance and
//      stops a phone buzzing once per event.
//   6. Records every folded-in alert in notifyLog, so a re-run or an
//      overlapping window never sends the same alert twice.
//
// Nothing here is per-user or per-device secret except the ntfy topic, and no
// credential reaches the browser: the service account stays in GitHub Secrets.
//
// Environment:
//   FIREBASE_SERVICE_ACCOUNT   service-account JSON (required unless
//                              GOOGLE_APPLICATION_CREDENTIALS is set)
//   LOOKBACK_MINUTES           how far back to scan (default 20)
//   NTFY_BASE                  server to publish to (default https://ntfy.sh)
//   MAX_SENDS_PER_RUN          safety cap on messages, after grouping
//                              (default 25; ntfy.sh allows 250/day)
//   DRY_RUN=1                  log the alerts instead of sending them

import { readFileSync } from "node:fs";
import { initializeApp, cert as certCredential } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  resolvePolicy,
  collectAlerts,
  buildDigest,
  notificationKey
} from "../js/notification-policy.js";

const LOOKBACK_MINUTES = Math.max(5, Number(process.env.LOOKBACK_MINUTES || 20));
const NTFY_BASE = String(process.env.NTFY_BASE || "https://ntfy.sh").replace(/\/+$/, "");
const MAX_SENDS = Math.max(1, Number(process.env.MAX_SENDS_PER_RUN || 25));
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || ""));
/** ntfy.sh accepts a burst of 60 requests then one every 5 seconds. */
const PAUSE_MS = 250;

function credential() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline && inline.trim()) {
    try {
      return certCredential(JSON.parse(inline));
    } catch (error) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON: " + error.message);
    }
  }
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file) {
    try {
      return certCredential(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      throw new Error(`Could not read ${file}: ${error.message}`);
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function changedSince(db, collectionName, since) {
  try {
    const snap = await db.collection(collectionName)
      .where("updatedAt", ">", since)
      .limit(300)
      .get();
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.warn(`Could not scan ${collectionName}:`, error.message);
    return [];
  }
}

async function adminUids(db) {
  try {
    const snap = await db.collection("users").where("isAdmin", "==", true).limit(20).get();
    return snap.docs.map((doc) => doc.id);
  } catch (error) {
    console.warn("Could not resolve administrators:", error.message);
    return [];
  }
}

/** One ntfy publish. Returns true when the server accepted it. */
async function publish(subscription, message) {
  const base = String(subscription.ntfyBase || NTFY_BASE).replace(/\/+$/, "");
  const response = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic: subscription.topic,
      title: message.title,
      message: message.message,
      tags: ["bell"],
      priority: 3
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ntfy answered ${response.status}${detail ? ": " + detail.slice(0, 200) : ""}`);
  }
  return true;
}

async function main() {
  const db = await (async () => {
    const config = credential();
    if (!config) {
      console.log("::warning::No Firebase credential is configured; phone alerts were not sent.");
      console.log("Add FIREBASE_SERVICE_ACCOUNT as a repository secret to enable them.");
      return null;
    }
    initializeApp({ credential: config });
    return getFirestore();
  })();

  if (!db) return;

  const policyDoc = await db.doc("settings/notifications").get();
  const policy = resolvePolicy(policyDoc.exists ? policyDoc.data() : null);
  if (!policy.channels.phone) {
    console.log("Phone alerts are switched off in settings/notifications. Nothing to do.");
    return;
  }

  const sinceMs = Date.now() - LOOKBACK_MINUTES * 60 * 1000;
  const since = Timestamp.fromMillis(sinceMs);

  const [orders, transactions, socialRequests, rentals, kyc, admins] = await Promise.all([
    changedSince(db, "orders", since),
    changedSince(db, "transactions", since),
    changedSince(db, "socialRequests", since),
    changedSince(db, "rentals", since),
    changedSince(db, "kyc", since),
    adminUids(db)
  ]);

  const alerts = collectAlerts({
    orders,
    transactions,
    services: [
      ...socialRequests.map((row) => ({ ...row, _kind: "socialRequests" })),
      ...rentals.map((row) => ({ ...row, _kind: "rentals" }))
    ],
    verifications: kyc,
    adminUids: admins,
    policy
  }).filter((alert) => alert.at >= sinceMs);

  console.log(`Scanned ${orders.length} orders, ${transactions.length} ledger rows, ` +
    `${socialRequests.length + rentals.length} service requests, ${kyc.length} verifications. ` +
    `Matched ${alerts.length} alerts.`);

  const subscriptions = new Map();
  async function subscriptionFor(uid) {
    if (subscriptions.has(uid)) return subscriptions.get(uid);
    const snap = await db.doc(`pushSubscriptions/${uid}`).get();
    const value = snap.exists ? { id: snap.id, ...snap.data() } : null;
    subscriptions.set(uid, value);
    return value;
  }

  // Which alerts still need sending, grouped per person. Anyone who is not
  // subscribed, or has already been told, never enters the map.
  const pending = new Map();
  let skipped = 0;

  for (const alert of alerts) {
    for (const uid of alert.recipientUids) {
      const logRef = db.doc(`notifyLog/${notificationKey(alert.eventId, alert.kind, alert.recordId)}::${uid}`);
      // eslint-disable-next-line no-await-in-loop -- one cheap read per alert
      if ((await logRef.get()).exists) { skipped += 1; continue; }

      const subscription = await subscriptionFor(uid);
      if (!subscription || subscription.enabled !== true || !subscription.topic) { skipped += 1; continue; }

      if (!pending.has(uid)) pending.set(uid, { subscription, alerts: [] });
      pending.get(uid).alerts.push(alert);
    }
  }

  const combine = policy.channels.digest !== false;
  let sent = 0;
  let failed = 0;

  for (const [uid, { subscription, alerts: list }] of pending) {
    if (sent >= MAX_SENDS) {
      console.log(`Reached MAX_SENDS_PER_RUN (${MAX_SENDS}); the rest will be picked up next run.`);
      break;
    }

    // One message per person when we can. If the administrator turned the
    // digest off, fall back to one message per event, each keeping its own copy.
    const messages = combine
      ? [buildDigest(list)]
      : list.map((alert) => ({ title: alert.title, message: alert.body, keys: [alert.key], count: 1 }));

    for (const message of messages) {
      if (sent >= MAX_SENDS) break;

      if (DRY_RUN) {
        console.log(`[dry run] ${uid} ← ${message.title}\n${message.message}`);
        sent += 1;
        continue;
      }

      try {
        await publish(subscription, message);
        // Mark every alert the message covered, so a partly-shown digest never
        // sends its hidden lines again.
        const batch = db.batch();
        for (const key of message.keys) {
          batch.set(db.doc(`notifyLog/${key}::${uid}`), {
            uid,
            eventId: key.split(":")[0] || "",
            kind: key.split(":")[1] || "",
            recordId: key.split(":").slice(2).join(":"),
            title: message.title,
            channel: "ntfy",
            status: "sent",
            digest: message.count > 1,
            covered: message.count,
            sentAt: Timestamp.now()
          });
        }
        await batch.commit();
        sent += 1;
        console.log(`sent ${message.count > 1 ? message.count + " alerts as one digest" : "1 alert"} → ${uid}`);
      } catch (error) {
        failed += 1;
        console.warn(`failed → ${uid}: ${error.message}`);
      }

      await sleep(PAUSE_MS);
    }
  }

  console.log(`Phone alerts: ${sent} message(s) sent (${combine ? "digested" : "one per event"}), ` +
    `${skipped} skipped, ${failed} failed.`);
  if (failed && !sent) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Phone-alert sender failed:", error);
  process.exitCode = 1;
});
