// Email queue and sub-administrator desk.
//
// The claim is the heart of this. Two sub-admins tapping the same mail at the
// same moment must not both get it, so claiming runs inside runTransaction():
// the transaction reads the mail, refuses if someone else already holds it,
// and writes the claim otherwise. Firestore serialises concurrent
// transactions on the same document, so exactly one of them wins — the loser
// sees the claim and gets told the mail is taken.

import {
  auth,
  db,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  runTransaction,
  arrayUnion
} from "./firebase.js";

export const SALES = "sales";
export const PRESENCE = "presence";

/** How recently someone must have checked in to count as online. */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

export const MAIL_STATUS = {
  pending: "Pending",
  approved: "Approved",
  paid: "Paid",
  rejected: "Rejected"
};

export const VERIFY_STATUS = {
  none: "Not requested yet",
  requested: "Waiting on the seller",
  submitted: "Seller has replied",
  verified: "Verified",
  failed: "Did not work"
};

function requireUser() {
  const user = auth.currentUser;
  if (!user) throw new Error("You are not signed in.");
  return user;
}

function rows(snapshot) {
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ------------------------------------------------------------------ */
/* live views                                                          */
/* ------------------------------------------------------------------ */

/** Mails nobody has picked up, oldest first. Sub-admins and admins. */
export function watchQueue(onRows, onError = console.error) {
  const q = query(
    collection(db, SALES),
    where("claimedBy", "==", null),
    orderBy("createdAt", "asc")
  );
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

/** Mails a particular sub-admin is holding. */
export function watchMyClaims(onRows, onError = console.error) {
  const user = requireUser();
  const q = query(
    collection(db, SALES),
    where("claimedBy", "==", user.uid),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

/** The signed-in seller's own submission, if any. */
export function watchMySale(onValue, onError = console.error) {
  const user = requireUser();
  const q = query(
    collection(db, SALES),
    where("uid", "==", user.uid),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(
    q,
    (snap) => onValue(snap.docs.length ? { id: snap.docs[0].id, ...snap.docs[0].data() } : null),
    onError
  );
}

/** Everything, for admin reporting. */
export function watchAllSales(onRows, onError = console.error) {
  const q = query(collection(db, SALES), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

/* ------------------------------------------------------------------ */
/* claiming — the atomic bit                                           */
/* ------------------------------------------------------------------ */
export async function claimMail(job, user) {
  const ref = doc(db, SALES, job.id);

  await runTransaction(db, async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists()) throw new Error("That mail is no longer in the queue.");

    const data = snap.data();
    if (data.claimedBy && data.claimedBy !== user.uid) {
      throw new Error(
        `${data.claimedByEmail || "Another sub-admin"} already picked this one up.`
      );
    }
    if (data.claimedBy === user.uid) return; // already yours

    t.update(ref, {
      claimedBy: user.uid,
      claimedByEmail: user.email || "",
      claimedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  });
}

/** Hand a mail back to the queue. */
export async function releaseMail(job, user) {
  const ref = doc(db, SALES, job.id);

  await runTransaction(db, async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists()) throw new Error("That mail no longer exists.");
    const data = snap.data();

    if (data.claimedBy !== user.uid) {
      throw new Error("You can only release a mail you are holding.");
    }

    t.update(ref, {
      claimedBy: null,
      claimedByEmail: "",
      claimedAt: null,
      verificationType: null,
      verificationStatus: "none",
      verificationRequestedAt: null,
      updatedAt: serverTimestamp()
    });
  });
}

/* ------------------------------------------------------------------ */
/* the verification loop                                               */
/* ------------------------------------------------------------------ */

/** Sub-admin tells the seller what Google is about to send. */
export async function requestVerification(job, type, user) {
  if (!["code", "prompt"].includes(type)) {
    throw new Error("Say whether Google is sending a code or a prompt.");
  }
  await updateDoc(doc(db, SALES, job.id), {
    verificationType: type,
    verificationStatus: "requested",
    verificationRequestedAt: serverTimestamp(),
    verificationRequestedBy: user.email || user.uid,
    verificationValue: "",
    updatedAt: serverTimestamp()
  });
}

/** Seller replies with the code, or "done" once they have tapped a prompt. */
export async function submitVerification(job, value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("Enter the code, or type done for a prompt.");

  await updateDoc(doc(db, SALES, job.id), {
    verificationValue: text.slice(0, 200),
    verificationStatus: "submitted",
    verificationSubmittedAt: serverTimestamp(),
    submissions: arrayUnion({
      category: job.verificationType === "prompt" ? "Prompt" : "OTP",
      text,
      time: new Date().toLocaleString()
    }),
    updatedAt: serverTimestamp()
  });
}

/** Sub-admin records the outcome. */
export async function completeMail(job, { approved, payout = 0, reason = "" }, user) {
  await updateDoc(doc(db, SALES, job.id), {
    status: approved ? "approved" : "rejected",
    payout: approved ? Number(payout) || 0 : 0,
    rejectionReason: approved ? "" : reason,
    reviewedBy: user.email || user.uid,
    reviewedAt: serverTimestamp(),
    verificationStatus: approved ? "verified" : "failed",
    updatedAt: serverTimestamp()
  });
}

/* ------------------------------------------------------------------ */
/* presence — who is actually at the desk right now                    */
/* ------------------------------------------------------------------ */
export async function heartbeat(user) {
  await setDoc(
    doc(db, PRESENCE, user.uid),
    {
      uid: user.uid,
      email: user.email || "",
      lastSeen: serverTimestamp(),
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export function watchPresence(onRows, onError = console.error) {
  return onSnapshot(collection(db, PRESENCE), (snap) => onRows(rows(snap)), onError);
}

export function isOnline(entry, now = Date.now()) {
  if (!entry || !entry.lastSeen) return false;
  const seen = typeof entry.lastSeen.toMillis === "function"
    ? entry.lastSeen.toMillis()
    : new Date(entry.lastSeen).getTime();
  return Number.isFinite(seen) && now - seen < ONLINE_WINDOW_MS;
}

/* ------------------------------------------------------------------ */
/* browser notifications for new mails                                 */
/* ------------------------------------------------------------------ */
export async function requestNotifyPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      return false;
    }
  }
  return Notification.permission === "granted";
}

export function notifyNewMail(email) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification("New mail in the queue", {
      body: `${email} was just submitted and is waiting for someone to pick it up.`,
      tag: "mailmart-queue"
    });
  } catch {
    /* notifications can be blocked even when permission reads granted */
  }
}

/** A short two-tone chime so an unattended desk still notices. */
export function chime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const at = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.start(at);
      osc.stop(at + 0.18);
    });
    setTimeout(() => ctx.close(), 900);
  } catch {
    /* audio is a nicety, never a requirement */
  }
}

/* ------------------------------------------------------------------ */
/* admin: find a user by email, to promote them                        */
/* ------------------------------------------------------------------ */
export async function findUsersByEmail(email) {
  const term = String(email || "").trim().toLowerCase();
  if (!term) return [];
  const snap = await getDocs(query(collection(db, "users"), where("email", "==", term)));
  return rows(snap);
}

export async function setSubAdmin(uid, value) {
  await updateDoc(doc(db, "users", uid), {
    isSubAdmin: !!value,
    updatedAt: serverTimestamp()
  });
}
