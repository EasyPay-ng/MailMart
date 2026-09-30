// Account handling shared by the sign-in, sign-up and dashboard pages.
//
// Two things live here:
//
//   friendlyAuthError()  — turns a Firebase Auth error code into the sentence
//                          a person needs, including the two that used to be
//                          swallowed as "Unable to sign in. Please try again.":
//                          a domain that is not authorised (Google popup) and
//                          a sign-in provider that is still disabled in the
//                          Firebase console.
//
//   ensureUserProfile()  — makes sure users/{uid} exists for a signed-in
//                          account. Registration used to write this document
//                          exactly once, right after createUserWithEmailAndPassword,
//                          and nothing ever retried it. When that one write was
//                          refused (undeployed firestore rules are the usual
//                          cause) the login existed but the profile never did:
//                          sign-up said "Unable to create your account",
//                          retrying said "email already in use", and the
//                          account was stuck in between. Every page that needs
//                          the profile now heals it through this function
//                          instead, so a refused first write is no longer a
//                          dead end.

import {
  db,
  doc,
  getDoc,
  serverTimestamp,
  runTransaction
} from "./firebase.js";
import { isAdminEmail } from "./admin.js";

/* ------------------------------------------------------------------ */
/* error translation                                                   */
/* ------------------------------------------------------------------ */

const AUTH_HINTS = {
  "auth/invalid-email": "Please enter a valid email address.",
  "auth/user-disabled": "This account has been disabled. Contact the administrator.",
  "auth/user-not-found": "No account was found with this email.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/invalid-login-credentials": "Incorrect email or password.",
  "auth/email-already-in-use":
    "An account with this email already exists. Sign in instead — or use “Forgot password?” to reset it.",
  "auth/weak-password": "Password must contain at least 6 characters.",
  "auth/too-many-requests":
    "Too many attempts. Firebase has paused sign-in from this device for a while — try again shortly.",
  "auth/network-request-failed": "Network error. Check your internet connection and try again.",
  "auth/popup-closed-by-user": "Google sign-in was cancelled.",
  "auth/cancelled-popup-request": "Google sign-in was cancelled.",
  "auth/popup-blocked":
    "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.",
  "auth/operation-not-allowed":
    "This sign-in method is not enabled yet. An administrator must turn it on in the " +
    "Firebase console under Authentication → Sign-in method.",
  "auth/admin-restricted-operation":
    "Sign-up is currently restricted. The Email/Password provider is probably not enabled " +
    "yet — an administrator must turn it on in the Firebase console under " +
    "Authentication → Sign-in method.",
  "auth/unauthorized-domain":
    "This site’s address is not on Firebase’s list of authorised domains, so Google sign-in " +
    "is blocked here. An administrator must add “<domain>” under Authentication → Settings → " +
    "Authorized domains. Email and password sign-in still works in the meantime.",
  "auth/operation-not-supported-in-this-environment":
    "Google sign-in cannot run from this address. Open the site on a proper domain (or localhost) and try again.",
  "auth/invalid-api-key":
    "The Firebase API key in js/firebase.js is not valid for this project. Check the web app configuration.",
  "auth/api-key-not-valid.-please-pass-a-valid-api-key.":
    "The Firebase API key in js/firebase.js is not valid for this project. Check the web app configuration.",
  "auth/app-deleted":
    "The Firebase web app configuration points at a project that no longer exists."
};

/**
 * Plain-English explanation of a Firebase Auth failure, with the fix where
 * there is one. Anything that is not an auth/ error (a Firestore refusal
 * during sign-up, say) falls through to a generic line naming the raw code,
 * so no failure is ever reduced to "please try again".
 */
export function friendlyAuthError(error, what = "sign in") {
  const code = String(error?.code || "");

  if (code && AUTH_HINTS[code]) {
    let hint = AUTH_HINTS[code];
    if (code === "auth/unauthorized-domain") {
      hint = hint.replace("<domain>", location.hostname || "this domain");
    }
    return hint;
  }

  if (code.startsWith("firestore/") || code.startsWith("auth/")) {
    return `Could not ${what} (${code}). If this keeps happening, run the setup check: setup-check.html`;
  }

  // Not an auth error at all — e.g. a Firestore write during registration.
  if (error instanceof Error && error.message) {
    return `Could not ${what}: ${error.message}`;
  }

  return `Could not ${what}. Please try again.`;
}

/* ------------------------------------------------------------------ */
/* profile creation / repair                                           */
/* ------------------------------------------------------------------ */

/**
 * Make sure users/{uid} exists for `user`, creating it when it does not.
 *
 * The document is only ever *created*, never updated: the security rules let
 * an owner create their own profile with exactly this shape and then only
 * tidy a few display fields, so a returning Google user must not re-run the
 * sign-up write (that was the old bug — merging createdAt/balance/isAdmin
 * back in is exactly what the rules refuse).
 *
 * Returns { created, exists, data }:
 *   created – true when this call wrote the document
 *   exists  – true when a profile exists now (created here or already there)
 *   data    – the profile as stored, when it could be read
 */
export async function ensureUserProfile(user, profile = {}) {
  if (!user) throw new Error("You are not signed in.");

  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    return { created: false, exists: true, data: snap.data() };
  }

  const email = user.email || profile.email || "";
  const displayName =
    profile.displayName || user.displayName || profile.username || (email.split("@")[0] || "Member");

  // This shape is exactly what firestore.rules demands on create: a fresh
  // wallet starts at ₦0.00, status active, and isAdmin only for the addresses
  // on the administrator list. Nothing here trusts the browser for value or
  // privilege — the rules re-check every field server-side.
  const data = {
    uid: user.uid,
    username: profile.username || displayName,
    phone: profile.phone || "",
    email,
    displayName,
    photoURL: profile.photoURL || user.photoURL || "",
    balance: 0,
    status: "active",
    isAdmin: isAdminEmail(email),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  // Create inside a transaction: two tabs signing in at the same moment are
  // serialised, so the second one sees the document the first one wrote and
  // skips the write instead of racing it.
  const created = await runTransaction(db, async (t) => {
    const fresh = await t.get(ref);
    if (fresh.exists()) return false;
    t.set(ref, data);
    return true;
  });

  if (created) return { created: true, exists: true, data };

  // Someone else created it mid-flight; report what is actually stored.
  const stored = await getDoc(ref);
  return { created: false, exists: stored.exists(), data: stored.exists() ? stored.data() : null };
}
