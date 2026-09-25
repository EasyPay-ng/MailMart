// Administrator handling for MailMart.
//
// IMPORTANT: this module decides where a user is *sent* after signing in. It
// does not decide what they are *allowed to do*. That is enforced server-side
// by firestore.rules, which only ever permits isAdmin to be true for the
// addresses listed below. Keep the two lists in sync.

import { db, doc, getDoc } from "./firebase.js";

export const ADMIN_EMAILS = [
  "baasituoppor01@gmail.com",
  "beniwealth70@gmail.com"
];

export function isAdminEmail(email) {
  if (!email) return false;
  return ADMIN_EMAILS.includes(String(email).trim().toLowerCase());
}

/**
 * Resolve whether `user` is an administrator.
 *
 * The user document is the source of truth. The email list is also accepted so
 * the named administrators still get in if their user document is missing —
 * firestore.rules grants the same privilege, so this is not a bypass.
 */
export async function isAdminUser(user) {
  if (!user) return false;
  if (isAdminEmail(user.email)) return true;

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    return snap.exists() && snap.data().isAdmin === true;
  } catch (error) {
    console.error("Administrator lookup failed:", error);
    return false;
  }
}

/** Send a freshly authenticated user to the admin console or the dashboard. */
export async function redirectAfterAuth(user) {
  const target = (await isAdminUser(user)) ? "admin.html" : "dashboard.html";
  window.location.href = target;
}
