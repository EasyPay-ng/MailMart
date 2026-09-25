// Administrator handling for MailMart.
//
// IMPORTANT: this module decides where a user is *sent* after signing in. It
// does not decide what they are *allowed to do*. That is enforced server-side
// by firestore.rules, which only ever permits isAdmin to be true for the
// addresses listed below. Keep the two lists in sync.
//
// One more thing this module is careful about: "not an administrator" and
// "could not ask" are different answers. Firestore refusing the lookup (most
// often because firestore.rules has never been deployed) used to look exactly
// like a plain non-admin, which silently bounced real administrators to the
// dashboard with no explanation. adminStatus() reports which one happened so
// the pages can say so.

import { db, doc, getDoc, firestoreErrorHtml } from "./firebase.js";

export const ADMIN_EMAILS = [
  "baasituoppor01@gmail.com",
  "beniwealth70@gmail.com"
];

export function isAdminEmail(email) {
  if (!email) return false;
  return ADMIN_EMAILS.includes(String(email).trim().toLowerCase());
}

/**
 * Resolve the signed-in user's administrator status.
 *
 * Returns { isAdmin, checked, error }:
 *   isAdmin  – true when the user may use the admin pages
 *   checked  – true when Firestore actually answered (false = the read failed)
 *   error    – the failure, when there was one
 *
 * The email list is accepted without a lookup so the named administrators
 * still get in if their user document is missing — firestore.rules grants the
 * same privilege, so this is not a bypass. Everything else is decided by
 * users/{uid}.isAdmin.
 */
export async function adminStatus(user) {
  if (!user) return { isAdmin: false, checked: false, error: null };
  if (isAdminEmail(user.email)) return { isAdmin: true, checked: true, error: null };

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    return {
      isAdmin: snap.exists() && snap.data().isAdmin === true,
      checked: true,
      error: null
    };
  } catch (error) {
    console.error("Administrator lookup failed:", error);
    return { isAdmin: false, checked: false, error };
  }
}

/** Resolve whether `user` is an administrator. */
export async function isAdminUser(user) {
  return (await adminStatus(user)).isAdmin;
}

/**
 * Put the reason an access check could not be completed in front of the user,
 * instead of silently sending them somewhere else. The page stops loading.
 */
export function showAccessCheckFailure(error, what = "administrator access") {
  const html = `<div class="empty">${firestoreErrorHtml(error, what)}</div>`;
  const screen = document.getElementById("loadingScreen");
  if (screen) {
    screen.innerHTML = html;
    screen.style.display = screen.style.display === "none" ? "flex" : screen.style.display;
    return;
  }
  document.body.insertAdjacentHTML("afterbegin", html);
}

/** Send a freshly authenticated user to the admin console or the dashboard. */
export async function redirectAfterAuth(user) {
  const target = (await isAdminUser(user)) ? "admin.html" : "dashboard.html";
  window.location.href = target;
}
