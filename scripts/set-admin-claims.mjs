// Optional: set Firebase Auth custom claims so administrators carry an
// `admin: true` claim on their ID token.
//
// This is defence in depth. firestore.rules already enforces administrator
// access on its own, so the app is secure without running this. The claim is
// useful if you later add a backend that wants to check privilege without a
// Firestore read.
//
// Setup (from a machine with Node 18+):
//   npm install firebase-admin
//
// Then download a service-account key from
// Firebase console > Project settings > Service accounts, and point the
// environment variable at it. NEVER commit that key — .gitignore excludes it.
//
//   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json \
//     node scripts/set-admin-claims.mjs baasituoppor01@gmail.com beniwealth70@gmail.com
//
// Users must sign out and back in (or have their token refresh) to pick up a
// newly issued claim.

import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const emails = process.argv.slice(2);

if (emails.length === 0) {
  console.error("Usage: node scripts/set-admin-claims.mjs <email> [email...]");
  process.exit(1);
}

initializeApp({
  credential: cert(process.env.GOOGLE_APPLICATION_CREDENTIALS)
});

const auth = getAuth();

for (const email of emails) {
  try {
    const user = await auth.getUserByEmail(email);
    await auth.setCustomUserClaims(user.uid, { admin: true });
    console.log(`admin claim set: ${email} (${user.uid})`);
  } catch (error) {
    console.error(`failed: ${email} — ${error.message}`);
  }
}
