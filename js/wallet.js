// Wallet: balances, deposits, withdrawals and the transaction ledger.
//
// Money moves in two steps on purpose:
//   1. the owner raises a *pending* request (deposit or withdrawal);
//   2. an administrator settles it, which is the only thing that moves funds.
//
// Step 2 runs inside runTransaction() so the ledger entry and the balance
// update either both land or neither does — a half-applied transfer is the
// one outcome a wallet must never produce.

import {
  auth,
  db,
  doc,
  getDoc,
  setDoc,
  collection,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  runTransaction
} from "./firebase.js";
import { bankCodeFor } from "./data/nigeria.js";

export const SETTINGS_ID = "platform";
export const TRANSACTIONS = "transactions";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function formatNaira(amount) {
  const n = Number(amount) || 0;
  return (
    "₦" +
    n.toLocaleString("en-NG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  );
}

export function formatDate(value) {
  if (!value) return "—";
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-NG", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function requireUser() {
  const user = auth.currentUser;
  if (!user) throw new Error("You are not signed in.");
  return user;
}

function toRows(snapshot) {
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ------------------------------------------------------------------ */
/* platform settings (admin writes, everyone reads)                    */
/* ------------------------------------------------------------------ */

export async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", SETTINGS_ID));
  return snap.exists() ? snap.data() : null;
}

export async function saveSettings(values) {
  await setDoc(
    doc(db, "settings", SETTINGS_ID),
    { ...values, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

/* ------------------------------------------------------------------ */
/* requests raised by the account owner                               */
/* ------------------------------------------------------------------ */

export async function requestDeposit({ amount, depositorName, bankUsed, proofImage }) {
  const user = requireUser();
  return addDoc(collection(db, TRANSACTIONS), {
    type: "deposit",
    direction: "credit",
    status: "pending",
    uid: user.uid,
    email: user.email || "",
    amount: round2(amount),
    depositorName: depositorName || "",
    bankUsed: bankUsed || "",
    proofImage: proofImage || "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export async function requestWithdrawal({ amount, bankName, accountNumber, accountName }) {
  const user = requireUser();
  return addDoc(collection(db, TRANSACTIONS), {
    type: "withdrawal",
    direction: "debit",
    status: "pending",
    uid: user.uid,
    email: user.email || "",
    amount: round2(amount),
    bankName: bankName || "",
    bankCode: bankCodeFor(bankName),
    accountNumber: accountNumber || "",
    accountName: accountName || "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

/* ------------------------------------------------------------------ */
/* live views                                                          */
/* ------------------------------------------------------------------ */

/** This user's own requests, newest first. */
export function watchMyTransactions(onRows, onError = console.error) {
  const user = requireUser();
  const q = query(
    collection(db, TRANSACTIONS),
    where("uid", "==", user.uid),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(q, (snap) => onRows(toRows(snap)), onError);
}

/** Every request on the platform, newest first. Administrator only. */
export function watchAllTransactions(onRows, onError = console.error) {
  const q = query(collection(db, TRANSACTIONS), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(toRows(snap)), onError);
}

/* ------------------------------------------------------------------ */
/* settlement (administrator only, enforced by firestore.rules)        */
/* ------------------------------------------------------------------ */

/**
 * Settle a pending request and move the money.
 *
 * First call moves pending -> approved and applies the balance change.
 * A second call marks an approved withdrawal completed, for the point where
 * the administrator has actually sent the bank transfer.
 */
export async function approveTransaction(tx, adminUser) {
  const txRef = doc(db, TRANSACTIONS, tx.id);
  const userRef = doc(db, "users", tx.uid);

  await runTransaction(db, async (t) => {
    const txSnap = await t.get(txRef);
    if (!txSnap.exists()) throw new Error("That request no longer exists.");

    const data = txSnap.data();
    if (data.status !== "pending" && data.status !== "approved") {
      throw new Error(`This request is already ${data.status}.`);
    }

    const moves = data.status === "pending";
    let next = null;

    if (moves) {
      const userSnap = await t.get(userRef);
      if (!userSnap.exists()) throw new Error("That user account is missing.");
      const current = Number(userSnap.data().balance || 0);
      next = round2(current + (data.type === "deposit" ? data.amount : -data.amount));
      if (next < 0) throw new Error("This user does not have enough balance.");
    }

    const patch = {
      status: moves ? "approved" : "completed",
      reviewedBy: adminUser.email || adminUser.uid,
      reviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    if (moves) patch.balanceAfter = next;

    t.update(txRef, patch);
    if (moves) t.update(userRef, { balance: next, updatedAt: serverTimestamp() });
  });
}

export async function rejectTransaction(tx, adminUser, reason = "") {
  await updateDoc(doc(db, TRANSACTIONS, tx.id), {
    status: "rejected",
    rejectionReason: reason,
    reviewedBy: adminUser.email || adminUser.uid,
    reviewedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}
