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
import { SALES } from "./emaildesk.js";

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
/* the ledger, named                                                   */
/* ------------------------------------------------------------------ */
// Every way money can enter or leave a wallet, in one place. The wallet is
// naira-only: every amount and every label below is ₦.

export const TX_LABELS = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  order_payment: "Marketplace purchase",
  order_payout: "Marketplace sale",
  email_payout: "Email sale payout",
  order_refund: "Order refund"
};

/**
 * What a ledger row is called, plus the one-line detail a history list should
 * show under it. Kept here so the user's wallet page and the administrator's
 * wallet page can never disagree about what a row means.
 */
export function describeTransaction(tx) {
  const type = tx?.type || "";
  const label = TX_LABELS[type] || type || "Transaction";
  const amount = formatNaira(tx?.amount);
  const reference = tx?.reference || "";

  let detail = "";
  switch (type) {
    case "deposit":
      detail = [tx.depositorName, tx.bankUsed].filter(Boolean).join(" · ") || "Bank transfer";
      break;
    case "withdrawal":
      detail = [tx.bankName, tx.accountNumber].filter(Boolean).join(" · ") || "Bank transfer";
      break;
    case "order_payment":
      detail = reference || "Marketplace order";
      break;
    case "order_payout":
      detail = reference || "Marketplace order";
      break;
    case "email_payout":
      detail = reference ? `Sold ${reference}` : "Email sold to MailMart";
      break;
    case "order_refund":
      detail = reference || "Cancelled order";
      break;
    default:
      detail = reference || "";
  }

  return { label, detail, amount };
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
 *
 * Deposits and withdrawals only. Order payments are settled from
 * admin-marketplace.html (which pays the seller at the same time) and email
 * payouts are sent from the sales screen — settling either of those from
 * here would move money twice, so this refuses them by name.
 */
export async function approveTransaction(tx, adminUser) {
  if (tx.type === "order_payment") {
    throw new Error(
      "Order payments are settled from the Marketplace Admin screen, which also pays the seller — settling one here would charge the buyer twice."
    );
  }
  if (tx.type !== "deposit" && tx.type !== "withdrawal") {
    throw new Error("Only deposits and withdrawals are settled from this screen.");
  }

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

/* ------------------------------------------------------------------ */
/* email sale payouts (administrator only)                             */
/* ------------------------------------------------------------------ */

/**
 * Pay a seller for an approved email sale, straight into their wallet.
 *
 * This used to be a bare status update: an administrator typed a dollar
 * amount, the sale document said "paid", and no money moved anywhere — the
 * seller's wallet never heard about it. The payout now lands in one
 * transaction: the sale is marked paid, the seller's balance is credited,
 * and a completed `email_payout` row is appended to the ledger, so the
 * balance change and its audit trail either both land or neither does.
 *
 * `amount` is naira, and must be a positive number.
 */
export async function payEmailSale({ sale, amount, adminUser }) {
  const value = round2(amount);
  if (!(value > 0)) throw new Error("Enter the payout amount in naira.");
  if (!sale?.uid) throw new Error("That sale has no seller attached.");
  if (sale.status === "paid") throw new Error("This sale has already been paid.");
  if (sale.status === "rejected") throw new Error("This sale was rejected — it cannot be paid.");

  const saleRef = doc(db, SALES, sale.id);
  const sellerRef = doc(db, "users", sale.uid);
  const reviewer = adminUser?.email || adminUser?.uid || "";

  await runTransaction(db, async (t) => {
    const saleSnap = await t.get(saleRef);
    if (!saleSnap.exists()) throw new Error("That sale no longer exists.");
    const saleData = saleSnap.data();
    if (saleData.status === "paid") throw new Error("This sale has already been paid.");

    const sellerSnap = await t.get(sellerRef);
    if (!sellerSnap.exists()) {
      throw new Error("The seller has no MailMart profile, so there is no wallet to pay into.");
    }

    const next = round2(Number(sellerSnap.data().balance || 0) + value);

    // Marking the sale paid…
    t.update(saleRef, {
      status: "paid",
      payout: value,
      paidAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    // …is the same act as crediting the wallet…
    t.update(sellerRef, {
      balance: next,
      updatedAt: serverTimestamp()
    });

    // …and the ledger says so, with the balance it produced. The owner of the
    // wallet is the seller (users/{uid}.email); the mail they sold is the
    // reference, so the history reads "Email sale payout — Sold that address".
    t.set(doc(collection(db, TRANSACTIONS)), {
      type: "email_payout",
      direction: "credit",
      status: "completed",
      uid: sale.uid,
      email: sellerSnap.data().email || "",
      amount: value,
      reference: saleData.email || "",
      balanceAfter: next,
      reviewedBy: reviewer,
      reviewedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  });
}
