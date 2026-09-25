// MailMart — Firebase client (replaces the previous Supabase-backed module).
//
// Every page already calls Firestore-shaped helpers (doc, collection, query,
// onSnapshot, arrayUnion, serverTimestamp) and Firebase-shaped auth helpers
// (signInWithEmailAndPassword, GoogleAuthProvider, onAuthStateChanged), so the
// page code binds straight to the real Firebase Web SDK with almost no change.
//
// The values below are *browser* configuration. A Firebase web apiKey is not a
// secret — it identifies the project, it does not authorise anyone. Real access
// control lives in firestore.rules, which is enforced on Google's servers.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  arrayUnion,
  runTransaction,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import {
  getAnalytics,
  isSupported as analyticsIsSupported
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyCc-0Gtmh7dIFWgnWglIQfjq-PlJu07IKE",
  authDomain: "mailmartz.firebaseapp.com",
  projectId: "mailmartz",
  storageBucket: "mailmartz.firebasestorage.app",
  messagingSenderId: "802413654231",
  appId: "1:802413654231:web:4e5d87d23d6a2317724092",
  measurementId: "G-LKLEWS7RPF"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

// Analytics is optional and unsupported in some embedded browsers, so a failure
// here must never take sign-in down with it.
export let analytics = null;
analyticsIsSupported()
  .then((supported) => {
    if (supported) analytics = getAnalytics(app);
  })
  .catch(() => {});

export {
  app,
  initializeApp,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  signOut,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  arrayUnion,
  runTransaction,
  writeBatch
};

// Collection names, so pages never hard-code them.
export const USERS = "users";
export const SALES = "sales";

/* ---------------------------------------------------------------------- */
/* diagnosing a refused request                                           */
/* ---------------------------------------------------------------------- */
//
// Every page used to print the same sentence — "Check your Firestore security
// rules and that you are signed in" — for *any* failure. That is misleading:
// an undeployed ruleset, a missing composite index, a database that was never
// created and a signed-out session all arrive here as different error codes
// and need different fixes. These helpers report what Firebase actually said,
// then translate it into the thing to do next.

export const PROJECT_ID = firebaseConfig.projectId;

export const SETUP_CHECK_PAGE = "setup-check.html";

const CODE_HINTS = {
  "permission-denied":
    `Firestore refused the request for this account. The usual cause is that ` +
    `firestore.rules has never been deployed to project ${firebaseConfig.projectId}: ` +
    `a Firestore database with no rules deployed runs the default deny-all ruleset, ` +
    `which refuses every read and write. Deploy it with ` +
    `"firebase deploy --only firestore:rules,firestore:indexes", then reload. ` +
    `If the rules are already deployed, this account is simply not allowed to read this data.`,
  "failed-precondition":
    `Firestore needs an index this query does not have. Deploy firestore.indexes.json ` +
    `("firebase deploy --only firestore:indexes") or open the create-index link Firebase ` +
    `printed in the browser console.`,
  unauthenticated:
    `There is no signed-in session behind this request. Sign in again and retry.`,
  "not-found":
    `Firestore could not find the database. Open the Firebase console for project ` +
    `${firebaseConfig.projectId} and create the Cloud Firestore database first.`,
  unavailable:
    `Firestore could not be reached. Check the internet connection and try again.`,
  "deadline-exceeded":
    `Firestore did not answer in time. Check the internet connection and try again.`,
  "resource-exhausted":
    `Firestore is rate limiting this project. Wait a few minutes and try again.`
};

/** Break a Firestore error into the parts a page needs to explain it. */
export function firestoreErrorInfo(error, what = "this data") {
  const code = String(error?.code || "")
    .replace(/^firestore\//, "")
    .trim() || "unknown";
  const message = String(error?.message || error || "Unknown error");
  // Firebase puts a working "create this index" link in failed-precondition
  // messages; keep it so the reader can act on it in one click.
  const linkMatch = message.match(/https:\/\/console\.firebase\.google\.com\/\S+/);
  const indexUrl = code === "failed-precondition" && linkMatch ? linkMatch[0] : "";

  return {
    what,
    code,
    message,
    indexUrl,
    hint: CODE_HINTS[code] || `Firestore returned "${code}". See the browser console for the full error.`,
    isPermissionDenied: code === "permission-denied"
  };
}

/** True when Firestore refused because of the rules (as opposed to any other fault). */
export function isPermissionDenied(error) {
  return firestoreErrorInfo(error).isPermissionDenied;
}

/** One-line explanation, for the inline notices the pages already render. */
export function firestoreErrorSummary(error, what = "this data") {
  const info = firestoreErrorInfo(error, what);
  const firstSentence = info.hint.split(". ")[0].trim();
  return info.code + ": " + firstSentence + (firstSentence.endsWith(".") ? "" : ".");
}

/** Plain-text explanation, for alert() and console. */
export function firestoreErrorText(error, what = "this data") {
  const info = firestoreErrorInfo(error, what);
  return [
    `Firestore could not load ${info.what}.`,
    ``,
    `Firebase said: ${info.code}`,
    info.hint,
    info.indexUrl ? `Create the index: ${info.indexUrl}` : "",
    ``,
    `Raw error: ${info.message}`,
    `Run the setup check for a full report: ${SETUP_CHECK_PAGE}`
  ].filter(Boolean).join("\n");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * HTML block for the ".empty" placeholders the pages already use. It names the
 * code Firebase returned, what that code means here, and links to the setup
 * check so the cause can be confirmed in one click.
 */
export function firestoreErrorHtml(error, what = "this data") {
  const info = firestoreErrorInfo(error, what);
  const indexLink = info.indexUrl
    ? `<p><a href="${escapeHtml(info.indexUrl)}" target="_blank" rel="noopener">Create the missing index →</a></p>`
    : "";
  return (
    `<div class="big">Could not load ${escapeHtml(info.what)}</div>` +
    `<p><b>Firebase returned <code>${escapeHtml(info.code)}</code>.</b> ${escapeHtml(info.hint)}</p>` +
    indexLink +
    `<p><a href="${SETUP_CHECK_PAGE}">Run the setup check →</a></p>`
  );
}
