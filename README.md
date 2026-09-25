# MailMart

Static MailMart frontend backed by Firebase Authentication, Cloud Firestore, and
Firestore Security Rules.

## Firebase setup

1. In the Firebase console, open **Build → Authentication → Sign-in method** and
   enable **Email/Password** and **Google**.
2. Open **Build → Firestore Database** and create a database.
3. Deploy the access rules:

   ```sh
   firebase deploy --only firestore:rules,firestore:indexes
   ```
4. Add your domain to **Authentication → Settings → Authorized domains**,
   otherwise Google sign-in is blocked and sign-in emails are rejected.
5. Register the administrator accounts. The addresses in `ADMIN_EMAILS` land on
   `admin.html` after signing in; everyone else lands on `dashboard.html`.

The browser configuration lives in `js/firebase.js`. A Firebase web API key
identifies the project — it is not a secret and is safe to ship in client code.
Never commit a service-account key.

## How administrator access works

There are two halves, and only the first one is security:

- **Enforced (server-side):** `firestore.rules`. It only ever allows `isAdmin`
  to be true for an address on the administrator list, and it is what stops a
  non-admin from reading the `sales` collection. This evaluates on Google's
  infrastructure and cannot be bypassed from the browser.
- **Cosmetic (client-side):** `js/admin.js`. It decides where a user is
  redirected after signing in, and `admin.html` re-checks the flag before
  rendering. Deleting this check changes where the browser goes, not what
  Firestore will hand over.

To change who is an administrator, edit **both** `ADMIN_EMAILS` in `js/admin.js`
and `adminEmails()` in `firestore.rules`, then redeploy the rules.

Optionally, `scripts/set-admin-claims.mjs` sets an `admin: true` custom claim
via the Firebase Admin SDK. The app does not depend on it, but it is convenient
if you add a backend later. It needs a service-account key, which must never be
committed.

## Migrating accounts from Supabase

Firebase and Supabase are separate identity systems, so accounts are not carried
over automatically. Pick one:

- **Re-registration** — simplest. Existing users sign up again.
- **Import** — the Firebase Admin SDK's `auth.importUsers()` accepts bcrypt
  hashes, which is what Supabase (GoTrue) stores. Export `auth.users` from the
  Supabase database and import with `{ hash: { algorithm: 'BCRYPT' } }`.

Either way, the `users` and `sales` rows in Postgres have to be copied into
Firestore by hand. There is no automatic conversion — export to JSON and write
the documents with a script.

## Local development

Serve the repository over HTTP (ES modules do not work reliably through
`file://`):

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Layout

| Path | Purpose |
| --- | --- |
| `js/firebase.js` | Firebase app, Auth and Firestore clients |
| `js/admin.js` | Administrator list and post-login redirect |
| `js/image.js` | Image → base64 helper (not wired into a page yet) |
| `firestore.rules` | Server-side access control |
| `scripts/` | Optional Admin SDK helpers |

## Security notes

The existing sales workflow collects third-party email passwords and OTP-like
follow-ups. This is extremely sensitive authentication data and it is stored in
the `sales` collection. Do not deploy that workflow without reviewing its
legality, consent model, encryption, retention/deletion rules, audit controls,
and Firestore rules. Prefer a provider-authorized OAuth transfer flow that never
exposes passwords or one-time codes.

Firestore documents are capped at 1 MiB. `js/image.js` exists so images are
downscaled before being stored as base64 — encoding a raw camera photo would
exceed that limit and the write would be rejected.
