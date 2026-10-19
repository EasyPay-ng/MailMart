# MailMart

Static MailMart frontend backed by Firebase Authentication, Cloud Firestore, and
Firestore Security Rules.

## Firebase setup

1. In the Firebase console, open **Build → Authentication → Sign-in method** and
   enable **Email/Password** and **Google**. Until Email/Password is enabled,
   every sign-up and sign-in is refused — `setup-check.html` reports exactly
   this as "Email/Password sign-in enabled: fail".
2. Open **Build → Firestore Database** and create a database.
3. Deploy the access rules:

   ```sh
   firebase deploy --only firestore:rules,firestore:indexes
   ```

   Until this step runs, the database uses the default deny-all rules and every
   page that reads Firestore fails. `.firebaserc` pins the project (`mailmartz`)
   so the command targets the right one; `setup-check.html` confirms it worked.
4. Add **`easypay-ng.github.io`** to **Authentication → Settings → Authorized
   domains**, otherwise Google sign-in is blocked and sign-in emails are
   rejected. Firebase ships that list containing only `localhost`,
   `mailmartz.firebaseapp.com` and `mailmartz.web.app` — none of which is where
   this site is actually served from (see **Hosting** below), so "Continue with
   Google" fails with `auth/unauthorized-domain` until the Pages domain is
   added by hand. Email/password sign-in is unaffected: it is not
   origin-restricted, which is why this can go unnoticed for a long time.
5. Register the administrator accounts. The addresses in `ADMIN_EMAILS` land on
   `admin.html` after signing in; everyone else lands on `dashboard.html`.

The browser configuration lives in `js/firebase.js`. A Firebase web API key
identifies the project — it is not a secret and is safe to ship in client code.
Never commit a service-account key.

## Hosting — and the trap that comes with it

The site is served by **GitHub Pages**, from the `main` branch, at
<https://easypay-ng.github.io/MailMart/>. It is *not* served by Firebase
Hosting, even though `firebase.json` still carries a `hosting` block and
`package.json` still has a `deploy:hosting` script.

That split is the single most important thing to understand about deploying
this app, because it is quietly asymmetric:

| File | Published by pushing to `main`? |
| --- | --- |
| `*.html`, `css/`, `js/` | **Yes** — Pages copies them straight out |
| `firestore.rules` | **No** — needs a Firebase deploy |
| `firestore.indexes.json` | **No** — needs a Firebase deploy |

Pushing to `main` therefore updates the *frontend* and nothing else. Editing
`firestore.rules`, committing it, and watching the Pages build go green looks
exactly like a successful deploy — but the database is still running whichever
ruleset was last sent to Firebase. For a database that has never had one sent,
that is the default **deny-all** ruleset, and then every page that reads
Firestore fails at once with `permission-denied`, signed in or not, admin or
not. That is the usual explanation for "it works locally but the live site
can't load anything".

Deploy the rules explicitly:

```sh
npm run deploy:rules      # firebase deploy --only firestore:rules,firestore:indexes
```

Or let CI do it: `.github/workflows/deploy-firestore.yml` deploys the rules and
indexes whenever either file changes on `main`. The workflow fails loudly until
a `FIREBASE_SERVICE_ACCOUNT` repository secret is added; a green Pages deploy
does not mean Firestore rules were deployed. The secret holds a service-account
JSON key from **Firebase Console → Project settings → Service accounts →
Generate new private key**. That key is a real credential: it belongs in GitHub
Secrets and must never be committed.

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

## Marketplace

Sellers apply under **Sell → Verification**. An administrator approves them,
which sets `isSeller` on their user document — the Firestore rules check that
flag before allowing listings.

Verified sellers can publish products with up to four photos, variations,
stock/low-stock indicators, delivery estimates, state-specific delivery fees,
and optional seller-set weekly or monthly payment plans. MailMart's separate
email buying/renting service is promoted as a banner; it is not a category for
user-created email listings.

The admin sets three separate marketplace charges under **Marketplace Admin
→ Fees**: buyer purchase fee (flat per order), seller listing/upload fee
(charged once when a new listing is posted), and seller sale commission
(percentage of the goods subtotal, excluding delivery). Paid Hot Deals and
Featured placements have independent admin-set prices, run for 24 hours, and
can be renewed for another 24 hours. A promotion request is charged to the
seller's wallet only after admin approval; the product listing itself remains
live when its promotion expires. Fee settings default to zero until MailMart
sets the agreed amounts. Affiliate commission is separate and funded by
MailMart, not deducted from the seller payout.

Buying an item records an order and raises a pending debit. An administrator
confirms payment; that atomically charges the buyer and pays the seller's
installment share with the configured seller commission deducted. Delivery can
be handled by the seller or MailMart. Ordinary orders are not paid out without
buyer confirmation; a delivery proof includes a picture and recipient
signature. The order-linked chat is visible only to its buyer, seller and
MailMart administrators. Admin/support can manually resolve a delivery dispute.

Voluntary cancellation of a paid, not-yet-dispatched order is reviewed by
MailMart. The buyer can request either full paid-amount wallet credit with no
fee, or a wallet refund after a fee of 20% of the full order price, capped at
the amount already paid. If MailMart or the seller cannot fulfill, an admin can
issue a full wallet refund of the amount actually paid. Seller payouts already
made are not automatically reversed; recovery/returns are a separate operator
decision. The browser's order quote is recomputed in `firestore.rules` against
the live listing and configured buyer/seller charges. Support/social URLs for
WhatsApp, Telegram, YouTube and X are admin-managed HTTPS settings and appear
only after official account URLs are configured; no unverified profile links
are seeded.

### Seller email notifications

Sellers are emailed when they receive an order, and buyers receive a status/refund notice after an administrator reviews a paid-order cancellation or issues a fulfillment-failure refund. These use the **Trigger Email** extension, which watches documents in `mail`. Install it with:

```sh
firebase ext:install firebase/firestore-send-email --project mailmartz
```

It needs SMTP credentials, and it requires the Blaze plan. The extension runs
with admin privileges, so the `mail` rules constrain browser writes: buyers
can notify only the real seller for an order, while admins can notify only the
buyer for an approved cancellation or fulfillment refund. This prevents
arbitrary client-generated mail.

## Notifications

MailMart has a notification centre: a bell (top bar on the dashboard, a floating
button elsewhere) with a feed of order events, plus system notifications in the
phone's notification shade. The administrator decides which events exist and
what they say, at **Admin → Notifications** (`admin-notifications.html`).

The switchboard is a single Firestore document, `settings/notifications`:

```json
{
  "version": 1,
  "channels": {
    "inApp": true, "browser": true, "sound": true,
    "phone": true, "digest": true
  },
  "audiences": { "buyer": true, "seller": true, "account": true, "admin": true },
  "events": {
    "buyer_shipped": {
      "enabled": true,
      "title": "Order Update",
      "body": "Your order {orderId} has been dispatched! Track your order in your dashboard."
    }
  }
}
```

There is one entry per event. Orders cover received, payment confirmed,
dispatched, completed, cancelled/refunded and balance-due; wallet covers deposit
approved or declined, withdrawal paid or declined, payouts and refunds; digital
services cover social-account and email-code requests; seller verification
covers approval and rejection; administrators get new orders awaiting payment.
Each can be turned off or reworded independently. The four `audiences` switches
are master switches: turning “Buyer” off silences every buyer event everywhere
without discarding the wording saved for it. `{orderId}`, `{item}`,
`{total}`, `{statusLabel}`, `{buyer}` and `{seller}` are filled in per order.
Saving takes effect on every open page immediately (the client watches the
document); a missing or half-saved document falls back to the catalogue
defaults in `js/notification-policy.js` rather than breaking the bell.

No rules change is needed: `settings/*` is already readable by every signed-in
user and writable only by an administrator, so the browser cannot re-enable an
event or edit its own wording.

### What actually delivers an alert

Two paths, one policy. Both read the same `settings/notifications`, and both
fold records through `js/notification-policy.js`, so the bell and the phone can
never disagree about what happened.

**1. The in-app bell (while a MailMart page is open).** The page keeps live
listeners on the records the person's rules already allow: their orders as
buyer and seller, their wallet ledger, their service requests, their
verification document — plus platform-wide orders and service requests for an
administrator. A status the administrator enabled appears in the feed, and the
browser's Notification API raises a system alert. `sw.js` supplies the click
handler and the `ServiceWorkerRegistration.showNotification` path Android
Chrome requires.

**2. Phone alerts (with MailMart closed).** `.github/workflows/notify-cron.yml`
runs `scripts/notify-worker.mjs` every five minutes. It is the only part of
MailMart with server privileges. Each run:

1. reads `settings/notifications`;
2. scans the records whose `updatedAt` is inside the look-back window
   (`orders`, `transactions`, `socialRequests`, `rentals`, `kyc`);
3. builds the same alerts the bell would, resolving each event's recipients
   (buyer, seller, account holder, or every administrator);
4. skips anyone who has not opted in, then **groups what is left by person**;
5. posts one message per person — a lone alert keeps its exact wording, two or
   more become a short digest (`MailMart · 3 updates` with one line each);
6. writes a `notifyLog/{event}:{kind}:{record}::{uid}` row for *every* alert the
   message covered, so a re-run, an overlapping window, or a digest cut short
   for length can never send the same alert twice.

Customers opt in on **Dashboard → Phone alerts**: it registers a long random
topic on `pushSubscriptions/{uid}` and walks them through three steps. On
Android the card offers **Open in ntfy app** — an `ntfy://host/topic` deep link
that subscribes in one tap. iOS has no deep-link support for this, so there the
customer taps **Copy topic** and adds it under *+ → Subscribe to topic*. Either
way there is no account, no key and no card.

The administrator cannot complete this step for a customer: the subscription
lives on their phone, and the topic belongs to their account. (Admins *can* read
any topic through the rules — that is there for support and auditing, and
subscribing your own phone to a customer's topic would put their order alerts on
your device.)

Choosing ntfy was deliberate: it needs no third-party signup, so the only
credential anywhere is the `FIREBASE_SERVICE_ACCOUNT` GitHub Secret that the
rules-deploy workflow already uses. The trade-offs, stated plainly:

- **Minutes, not seconds.** GitHub's shortest schedule is five minutes and runs
  can queue under load.
- **Scheduled workflows pause** after 60 days without repository activity. The
  workflow file is the reminder; re-enable it from the Actions tab.
- **The topic is the password.** `ntfy.sh` has no accounts, so anyone who learns
  a topic can read it. Topics are long random strings, readable only by their
  owner and administrators, and can be rotated by turning alerts off and on.
- **Free ntfy limits** apply per publishing address: a burst of 60 requests,
  then one every 5 seconds, and 250 messages a day.
- **Message budget.** One alert is one message per recipient, so without
  grouping a 40-order day could easily reach 150–200 messages. Grouping makes it
  one message per person per run instead: the same day is roughly 40–60. The
  sender pauses 250 ms between sends and stops at `MAX_SENDS_PER_RUN`
  (default 25 messages), so it cannot trip the burst limit even on a bad day.
  Turn grouping off under **Channels → One message per person** if you would
  rather have one notification per event; the per-event wording and switches
  are unchanged either way.
- **iOS needs the ntfy app**, which uses Apple's push service; Android keeps a
  socket open. Both are fine for this volume.

This path replaces the earlier "needs FCM plus a Cloud Function" note: FCM would
be instant and would not need a third-party app, but it requires the Blaze plan,
a VAPID key and a device-token lifecycle. The ntfy sender is the free version of
the same idea and can be swapped later without touching the policy or the bell.

### Deploying this

`pushSubscriptions` is a new collection, so `firestore.rules` must reach
Firebase. That already happens by itself: `.github/workflows/deploy-firestore.yml`
watches `firestore.rules` on `main` and deploys it when the change lands — no
manual step. `npm run deploy:rules` is only needed if you are deploying from a
workstation instead.

The one thing no workflow can supply is the `FIREBASE_SERVICE_ACCOUNT`
repository secret. If it is already set (the rules deploy uses the same one),
phone alerts start with the next scheduled run. If it is missing, the sender's
run summary says exactly that and nothing is sent; the in-app bell is unaffected.

### Trying it quickly

1. Sign in as an administrator, open **Admin → Notifications**, and leave
   “Order dispatched” enabled.
2. On a phone, sign in as the buyer, tap the bell and choose **Enable device
   alerts**.
3. As the seller or an administrator, mark that order shipped. The buyer's open
   page shows a “Order Update · Your order #… has been dispatched!” alert in
   the shade, and the bell badge increments.
4. For the closed-app path, have the buyer open **Dashboard → Phone alerts**,
   turn them on, and subscribe to the topic in the ntfy app. Then ship another
   order: the alert arrives within about five minutes even with no MailMart tab
   open.

`tests/notifications.test.mjs` covers the policy merge, audience separation,
templates, ordering and de-duplication offline; it needs no Firebase.

## Referrals and affiliates

Open **Dashboard → Referrals & Affiliates** (`referrals.html`). The program has
four reward tracks, all in naira. Referrals must be email-verified and approved
by an administrator before their rewards can be released:

| Program | Qualification | Recipient and amount | Frequency |
| --- | --- | --- | --- |
| Email referral | The invitee’s approved email sale is paid into their wallet | Referrer: **₦200** | Once per invitee, with the first payout |
| Goods referral | The invitee’s first paid goods order is delivered and they confirm receipt | Referrer: **₦500**; invited buyer: **₦200** | Once per invitee, not every order |
| Affiliate sales | A sale attributed at checkout to an approved affiliate is fully paid, delivered and confirmed | Affiliate: admin-set category/product rate (fallback **5%**) of the discounted goods subtotal; paid by MailMart | Per qualifying order |
| Lifetime direct-referral activity | Eligible earnings/spending actually settle; purchases are fulfilled | Referrer: **4–5%**, chosen by admin for that referral | Every eligible event, no expiry or downline |

**Registration alone earns nothing.** Email verification is available at sign-up
and on the referral page, and is required before applying to be an affiliate.
Delivery and buyer purchase fees never enter the affiliate calculation. Admin can
set category defaults and per-product overrides (fallback 5%); for example, a 5% rate on ₦10,000
of goods pays **₦500** from MailMart funds, regardless of the delivery/service
fees. The seller payout is not reduced by affiliate commission.

### Links and attribution

- Invitation links point to `register.html?ref=MM-<uid>`. The entire,
  case-sensitive Firebase UID is used, avoiding truncated-code collisions.
  A code may also be entered on the registration form. Existing users get a
  code when they open Referrals; they cannot retroactively add an inviter.
- Profile, code and invitation record are created atomically. If profile
  creation fails, the pending invitation is bound to that specific new UID in
  session storage, so the dashboard/wallet repair in the same browser tab can
  retry it without assigning it to another account. Browsers that disable
  session storage support this only in the current document.
- Only exact public `referralCodes/{code}` lookups are available before login.
  They contain a UID, affiliate availability and timestamps, **not** private
  user profiles. Invitation history uses minimal `referrals` records instead
  of granting referrers permission to read their invitees’ accounts or sales.
- Affiliate links point to `marketplace.html?aff=MM-<uid>`; an optional `item`
  parameter opens a specific product. Signed-out buyers return to that product
  after signing in/registering. The code persists in that tab, can be replaced
  by another link, and is visible/editable at checkout. An inactive or invalid
  code must be corrected or removed; it is never silently credited elsewhere.
- Affiliate approval is checked by the rules when the order is placed. The
  stored affiliate and referrer cannot change afterwards. Suspending an
  affiliate prevents new attributions but does not revoke already attributed
  legitimate sales. An affiliate cannot earn on their own purchase or listing.
  Referral rewards are direct/one-level only; there are no rewards on referrals
  of referrals.

### Administrator operations and money movement

Use **Admin → Referrals & Affiliates** (`admin-referrals.html`) to approve,
reject, suspend or reactivate affiliates. Applicants must accept the affiliate
terms and describe how they will bring sales; rejected applications may be
resubmitted without erasing the previous review metadata.

The email reward is part of `payEmailSale()` itself. For approved referrals the
seller payout and ₦200 referrer credit commit together. Otherwise the seller
still receives their approved payout and the fixed reward is queued in
`referralClaims`; it is not spendable until reviewed and released. The first-paid
sale marker is set immediately so a second sale cannot consume another fixed
bonus. A sale must be approved before **Pay into wallet** is available.

For goods, confirmation of delivery records the first completed order on the
invitation record but **does not move money**. This shared record serialises
simultaneous deliveries, so an administrator cannot consume the first-purchase
bonus by reviewing a later order first. After delivery, use **Release eligible
rewards** in Referral Admin. It atomically applies every eligible credit, wallet
balance, immutable ledger entry and review marker. Later orders skip fixed
purchase bonuses but can still earn affiliate commission. Unpaid, cancelled,
undelivered and refunded orders do not qualify. Refunds/cancellations are only
available before reward completion; a completed, rewarded order cannot be
refunded through this workflow.

The fixed bonuses and affiliate commission **can stack** if both independently
qualify. A referrer who is also the attributed affiliate receives both credits;
the balance is accumulated once, with separate ledger rows and running balances.
All program rewards are **platform-funded**, with the quoted seller payout
unchanged. There is no automatic budget/funding-pool debit; the operator must
budget for these credits just as for manual admin credits.

The wallet’s referral transaction types are `email_referral`, `purchase_referral`,
`purchase_welcome`, `affiliate_commission` and `lifetime_commission`. Deterministic IDs and one-time
milestone markers prevent retries/concurrent reviews from paying twice. Only
administrators can write completed rewards, and the rules validate their source
events, recipients and amounts. Ordinary users cannot raise pending rewards,
change their inviter, or activate affiliate access. Wallet-balance arithmetic
still has the existing trusted-administrator boundary described below.

**Deployment:** publish the frontend **and** run `npm run deploy:rules` to deploy
the new rules and indexes. A Pages deploy alone is insufficient. No Cloud
Function, service-account file in the browser, or new paid extension is needed.
New orders store their payment-ledger document ID; settlement of older orders
resolves the existing payment outside the transaction, then revalidates it
inside. This also fixes the Web SDK’s unsupported transaction-query/read-after-
write path in the former marketplace settlement code.

### Referral verification, lifetime commission and dashboard

- New invitation records start `unverified`, or `pending` if the Firebase sign-in
  email is already verified. Verification uses the actual Firebase ID token;
  it **never automatically approves a referral** or clears a fraud flag.
- **Referral Admin → Referral verification & abuse review** supports pending,
  approved, flagged and rejected cases, public reasons, spam/bot/duplicate/
  reward-looting risk categories, and a per-referral **4–5% rate**. The initial
  rate is 4%; admin changes apply to future events. Claims keep the event's
  original rate. Approval requires recorded sign-in email verification.
- Public decisions are visible to the inviter/invitee. Investigation notes are
  in separate, admin-only append-only `referralAudit` records, not on the shared
  referral record. This is a **manual review queue**, not an automatic bot or
  fraud detection system.
- Real eligible ledger types are `email_payout`, `order_payment`, `order_payout`,
  legacy `social_sale` records, `social_purchase` and `rental_payment`. New
  social settlements are customer purchases only. Commission uses the actual
  settled naira amount (including the fees in an actual goods debit;
  unlike the separate product-specific, goods-only affiliate base). Deposits, withdrawals,
  refunds, arbitrary admin credits and **all referral/affiliate rewards are
  excluded**. No recursive rewards-on-rewards or downline commissions.
- Every lifetime event queues `referralClaims/lifetime_<sourceTransactionId>`;
  it does not immediately inflate available cash. Admin releases only after
  referral approval, exact source/amount validation and business fulfilment.
  Goods require confirmed delivery **and full payment** where applicable.
  Lifetime rewards are additional platform-funded credits, not deductions from
  the invitee's quoted earnings and not extra purchase charges.
- Fixed first-purchase bonuses held during referral review release or reject
  **together**. An unrelated approved affiliate's valid commission can proceed
  independently. Flagged/rejected referrals accrue no new rewards while blocked;
  existing pending claims remain blocked until the referral is approved, or
  until the claim itself is rejected with a reason. Paid rewards are immutable.
- `referrals.html` uses real approved-referral counts, pending claim totals and
  the current wallet balance in the screenshot-inspired 2×2 cards. Successful
  means verified/admin-approved, not just registrations. **Shopping credits
  are not enabled**: no issuance/redemption policy was provided, so that card
  explicitly shows ₦0/not enabled. All current bonuses are cash. Screenshot
  example balances are never seeded into user accounts.
- Existing invitation records are not silently auto-approved or retroactively
  attributed. An existing invitee can verify their email and enter review;
  already paid fixed bonuses/ledger entries remain one-time. New lifetime claims
  are created by future settlement events, not by scanning historical deposits.

## Seller-set goods instalments

Sellers choose whether a product allows weekly (1–35 payments) or monthly
(1–12 payments) instalments. Plans are zero-interest; the entire order total is
split in integer kobo and the final payment absorbs rounding. Buyers may also
choose full “cash-and-carry” payment, which must be paid in full before dispatch.
All instalment plans require full payment before the product is delivered.

For plans longer than three weeks or two months, the seller must bring the
product to MailMart's office for receipt/verification before the plan is
available. Each order snapshots its payment schedule and fulfillment terms.
Due dates advance by weeks or calendar months from the first confirmed payment.
The buyer can request the next installment from **Orders**; each payment is
confirmed by an administrator under **Marketplace Admin → Awaiting payment**.
Payment and the seller's share settle atomically, so the seller is paid only the
current installment share and the configured sale commission is deducted.
There is no automatic wallet debit or reminder service.

The missed-payment policy still needs a secure scheduled backend before it can
be automated. In particular, the requested first-missed-payment carry-over and
second-miss cancellation/no-refund rule conflicts with paying the seller as
each installment arrives (and the instruction that defaulted funds go to
MailMart). The app does **not** currently auto-cancel/default an order or divert
already-settled installment money; that accounting must be clarified before
launching long-duration plans.

For a paid, not-yet-dispatched order, a buyer can request cancellation for
review: either the full amount paid as no-fee wallet credit, or a wallet refund
after a fee equal to 20% of the full order price, capped at the amount already
paid. If MailMart or the seller cannot fulfill, an administrator can issue a
full refund of the amount actually paid. Already-issued seller payouts are not
automatically reclaimed; returned goods and seller/platform recovery remain an
admin decision. Canceled/refunded orders are excluded from completed-order
rewards.

## MailMart social sales and manual Gmail code rentals

User entry: **Dashboard → Services** (`services.html`). Administration:
`admin-services.html`, linked from the other admin desks. Catalogs are empty
until an administrator configures real prices and availability; no fictional
stock, balances, Gmail accounts or rental codes are generated.

### MailMart social accounts for customer purchase

An administrator lists social accounts or business assets that MailMart owns or
is authorized to transfer, sets one customer price, and manages available
stock. Customers can request a purchase from MailMart; this flow no longer
accepts social-account sales from users. Offers must describe only transfers
permitted by the platform. The app never collects passwords, session cookies or
recovery secrets.

A purchase request snapshots the current admin price. A changed displayed
quote requires review/renewed consent; later catalog edits do not reprice an
accepted request. Admin manually verifies MailMart's entitlement, the platform
permission, available stock and the completed handoff. Completion atomically
debits the quoted wallet amount, reduces stock, writes one immutable ledger row
and queues the eligible lifetime claim. Rejection/cancellation of an uncharged
request moves no money. Personal-account trades forbidden by a provider's terms
must not be listed or approved. Legacy inbound social-sale requests can only be
rejected; they cannot be settled.

**External transfer limitation:** this is a reviewed request/settlement flow,
not a provider API or escrow service. No external social-platform transfer can
be rolled back by a Firestore transaction. Buyer funds are rechecked at
settlement, not reserved at request creation; operators must establish a safe
handover/payment procedure and resolve external transfer disputes. Do not
represent it as automatic account delivery or protected escrow.

### Authorized Gmail code rentals

1. Admin creates categories (for example card-sale-platform registration,
   Instagram registration, other authorized tests), sets **at least ₦50/code**,
   and enables availability only when an authorized inbox can be provided.
2. A verified user chooses a category and explains their authorized purpose.
   The full category price must be available at request time; ₦50 alone is not
   sufficient for a higher-priced category. **One request = one code.**
3. Admin reviews the use, supplies an existing inbox they control or are
   authorized to provide, and confirms that authorization. Assignment atomically
   **rechecks and reserves/debits the quoted code price**. Insufficient funds or
   duplicate assignment leaves the request and wallet unchanged.
4. The customer sees the assigned address, not a Gmail login. Admin manually
   retrieves the requested code from that authorized inbox and delivers it.
   Delivery finalizes the reserved ledger entry without charging twice. Only
   then is a lifetime commission claim created.
5. The code is in private `rentalCodes/{rentalId}`, **not** the permanent rental
   record, financial ledger, referral record or public catalog. In-app access expires ten
   minutes after delivery (provider expiry may be sooner); rules deny expired reads even to admin clients and
   prohibit collection listing. If an unfulfilled funded rental is rejected,
   refund exactly its reserved price once; no lifetime commission is earned.

Gmail dot/plus/Googlemail aliases share one canonical lock. A mailbox is bound
to one customer and cannot be recycled to another customer or used by two active
rentals, avoiding cross-customer account-recovery exposure. Users acknowledge
that a temporary code service does not grant permanent mailbox ownership.

**No automatic Gmail-account generation, Gmail API integration, unauthorized
inbox access, other people's sign-ins, financial/banking OTPs, spam, mass
registration or restriction bypass.** Requests are manually reviewed, not a
technical guarantee of an external provider's consent. Admin must reject
unapproved purposes. No permanent email account, inbox login or password is
sold to customers through Services. The separate legacy user-to-MailMart
email-sale workflow is unchanged and is extremely sensitive; see Security notes
below before enabling it.

**Production retention gate:** enable Firestore TTL on
`rentalCodes.expiresAt` (Console → Firestore → TTL, or an appropriately authorized
`gcloud firestore fields ttls update expiresAt --collection-group=rentalCodes
--enable-ttl --project=mailmartz`). TTL deletion is asynchronous; expiry access
control is enforced by rules even before deletion. Code payload indexing is
excluded in `firestore.indexes.json`. Never use service-account keys or Gmail
passwords in client code. Decide lawful retention/deletion for request metadata
and investigation records separately before launch.

## Wallet

The wallet is **naira-only**. Every amount stored in `users/{uid}.balance` and
every row of the `transactions` ledger is ₦, formatted with
`formatNaira()` from `js/wallet.js`. Nothing in the app quotes, stores or pays
a foreign currency.

There is one balance per account (`users/{uid}.balance`) and one append-only
ledger (`transactions`). A ledger row records the type, the direction, the
amount, the balance it produced (`balanceAfter`), and — when an administrator
acted — who acted. The types:

| Type | Direction | Who creates it | What it means |
| --- | --- | --- | --- |
| `deposit` | credit | the user (pending) → admin settles | Bank transfer into the wallet |
| `withdrawal` | debit | the user (pending) → admin settles | Payout to a Nigerian bank |
| `order_payment` | debit | the buyer, when placing a marketplace order | Held pending until an administrator confirms the order |
| `order_payout` | credit | settlement, atomically | The seller's share of a confirmed order |
| `email_payout` | credit | the sales screen, atomically | Payment for an approved email sale |
| `order_refund` | credit | a refund, atomically | A refunded order returned to the buyer |
| `listing_fee` | debit | seller listing creation, atomically | Admin-configured one-time fee for a new listing |
| `listing_promotion` | debit | admin approves a promotion, atomically | Paid 24-hour Hot Deal or Featured placement |
| `email_referral` | credit | first email payout, atomically | ₦200 to the invitee’s referrer |
| `purchase_referral` | credit | referral admin, after first delivery | ₦500 to the buyer’s referrer |
| `purchase_welcome` | credit | referral admin, after first delivery | ₦200 to the invited buyer |
| `affiliate_commission` | credit | referral admin, after paid delivery | Admin-set product rate of goods subtotal; MailMart-funded |
| `lifetime_commission` | credit | referral admin, after source/review checks | 4–5% of an eligible direct invitee event |
| `social_sale` (legacy) / `social_purchase` | credit / debit | legacy records / reviewed service settlement | Historical social-sale credits; new settlements debit the customer for a MailMart offer |
| `rental_payment` | debit | admin assigns, then delivers | Reserved one-code price, finalized on delivery |
| `rental_refund` | credit | admin rejects an unfulfilled funded rental | Return exactly the reserved code price |

Money moves in two steps, so that no user can credit themselves:

1. A user raises a **pending** request — a deposit (with a screenshot of the
   transfer), a withdrawal to a Nigerian bank, or a marketplace order (which
   raises its own pending `order_payment`). This appends a row to
   `transactions` and moves nothing.
2. An administrator settles it. This is the only thing that changes a balance:
   * deposits and withdrawals are settled from `admin-wallet.html`;
   * order payments are confirmed from **Marketplace Admin**, which charges the
     buyer, pays the seller, completes the pending `order_payment` row and
     writes the seller's `order_payout` row — all in one transaction;
   * email sales are paid from the sales screen (**Pay into wallet**), which
     marks the sale paid, credits the seller's balance and writes the
     `email_payout` row — again in one transaction.

Every settlement runs inside a Firestore `runTransaction()`, so the ledger
row(s) and the balance update either all land or none does — a half-applied
transfer is the one outcome a wallet must never produce. Settling an
`order_payment` from the wallet screen is refused by `js/wallet.js` (and would
charge the buyer twice); it belongs to the marketplace screen.

A refund is a new `order_refund` credit row, not an edit of history: the
purchase stays on the buyer's record and the refund sits next to it.

Deposits are manual by design: the administrator publishes the account users
transfer to, users upload proof, and an administrator confirms and credits —
the one-hour target. Withdrawals are approved, then marked paid once the bank
transfer is actually sent — the 24-hour target.

The `transactions` query needs the composite index in
`firestore.indexes.json`:

```sh
firebase deploy --only firestore:indexes
```

**Trust boundary, stated plainly:** the client computes the new balance, and
the rules only check that whoever writes it is an administrator. That stops
ordinary users cold, but a compromised or careless administrator session could
still write a wrong number. If you want the arithmetic verified server-side,
settlement should move into a Cloud Function. The ledger is append-only either
way, so a bad entry is always traceable.

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

## Email queue and sub-administrator desk

A seller submits a mail under **Sell Email**. It lands in a queue, and the
seller is told to keep the account open, because Google is about to send
something.

Someone at the desk claims the mail, logs the account in on their phone,
triggers Google's check, and asks the seller for it. The seller's page then
opens a field — a box for the code, or a request to type **done** once they
have tapped a prompt. Whatever they send goes straight back to whoever is
holding that mail.

**Only one person can hold a mail.** Claiming runs inside a Firestore
`runTransaction()`: it reads the mail, refuses if someone else already holds
it, and writes the claim otherwise. Two sub-admins tapping the same mail at
the same instant are serialised, so exactly one wins and the other is told it
is taken. `firestore.rules` enforces the same condition independently, so a
modified client cannot claim a mail that is already held — the transaction is
what makes it fair, the rules are what make it enforced.

Administrators promote sub-admins under **Desk Team**: find a registered user
by email and add them. Nobody can make themselves a sub-admin by signing up;
only an administrator sets that flag.

New mails reach everyone with the desk open. The queue updates live, a banner
appears, the browser shows a notification once permission is granted, and a
short chime plays. A presence heartbeat records who has had the desk open in
the last two minutes, so both the desk and the team page show who is actually
there rather than who merely has permission.

### A word on what this workflow stores

It collects account passwords, and it has sub-admins signing into those
accounts on their own phones. The rules keep passwords readable only by the
seller, administrators and whoever is on the desk — but that is access
control, not protection. This concentrates a great deal of legal and security
exposure in one place, and it deserves advice before real accounts flow
through it.

## Local development

Serve the repository over HTTP (ES modules do not work reliably through
`file://`):

```sh
python3 -m http.server 8000
# or: npm run serve
```

Then open `http://localhost:8000`.

## Tests

Use Node 22 for tests. The static site itself still has no build step.

```sh
npm ci
npm test
```

The offline suite executes the real business modules behind a mocked Firebase
boundary and checks amounts, case-sensitive links, signup recovery, first-sale
and first-purchase milestones, concurrent payouts, overlapping recipients,
transaction read ordering, rollback, checkout attribution and page syntax.
It does **not** substitute for security-rule tests.

For the actual Firestore rules and the full checkout-to-reward flow, install
Java 21 and run:

```sh
npm run test:rules
```

This downloads/starts the official Firestore emulator and uses the disposable
`demo-mailmart` project, never production. It needs no Firebase credentials.
The emulator tests use authenticated contexts and the unmodified business
modules, replacing only their Firebase connection. `.github/workflows/test.yml`
is configured to run both suites with Node 22 and Java 21 on pull requests and
`main`.

**Local validation (2026-10-15):** 60 offline policy/transaction/source checks pass.
Mocked Chromium smoke covers desktop/mobile referral results, private admin
reviews, social requests/settlement, manual Gmail assignment/code delivery/
reveal, instalment checkout/delivery and monthly admin confirmation, in addition
to the earlier registration/affiliate flows. These use no production data and
are not a substitute for rules tests.

Java 21 was installed in the scratch environment, but `npm run test:rules`
cannot download the official `cloud-firestore-emulator-v1.19.8.jar` from
`storage.googleapis.com` because that host is blocked here. The expanded rules
suite has **not executed** and the rules have **not been compiler-verified in
this workspace**. Run the official emulator suite successfully in CI/an
unrestricted environment, verify source/index rules against a disposable
project, and configure rental-code TTL before production. The pull-request CI
workflow is configured to run these checks; no deployment or production-data
change has been performed.

## "Check your Firestore security rules…" — what that means

Most pages used to show one sentence for every failure:

> Could not load … Check your Firestore security rules and that you are signed in.
> Could not load … Check your Firestore security rules and that you are an administrator.

That sentence is now gone from the pages: each one reports the error code
Firebase actually returned plus what to do about it. The three things that
produce it, in the order they are worth checking:

1. **The rules were never deployed.** A Firestore database runs the default
   *deny-all* ruleset until `firestore.rules` is deployed, and then **every**
   read and write from a page is refused — signed in or not, admin or not. This
   is the usual cause when *most* pages fail at once. Fix it from the folder
   that contains `firebase.json`:

   ```sh
   npm i -g firebase-tools     # once
   firebase login              # once
   firebase deploy --only firestore:rules,firestore:indexes
   ```

   The same applies if the project was left in Firestore's "test mode": those
   rules allow everything for 30 days and then start refusing everything.

   Note that **pushing to `main` does not do this for you.** GitHub Pages
   publishes the HTML and JavaScript and ignores `firestore.rules` entirely, so
   the rules can sit correct-looking in git while the live database still
   refuses everything — see [Hosting](#hosting--and-the-trap-that-comes-with-it).

2. **A composite index is missing.** That arrives as `failed-precondition`, not
   `permission-denied`, and Firebase prints a one-click create-index link in the
   browser console. `firebase deploy --only firestore:indexes` creates the ones
   the pages need (see `firestore.indexes.json`).

3. **The account genuinely is not allowed.** `permission-denied` on an
   admin-only screen, while the ordinary pages work, means the rules are live
   and simply do not grant that account the privilege — check `ADMIN_EMAILS` in
   `js/admin.js` and `adminEmails()` in `firestore.rules`, or the `isAdmin` /
   `isSeller` / `isSubAdmin` fields on the user's document.

`setup-check.html` answers the question directly. It now checks Authentication
as well as Firestore, and the auth checks run even while signed out:

* **Authentication reachable** — the project's public auth config answers with
  the web API key the app itself uses.
* **Domain authorised for Google sign-in** — the address the site is open on is
  compared with Firebase's authorised-domain list. A domain that is not on the
  list is exactly what makes "Continue with Google" fail with
  `auth/unauthorized-domain` (add it under **Authentication → Settings →
  Authorized domains**).
* **Email/Password sign-in enabled** — a deliberately impossible sign-in probe
  tells you whether the provider is enabled, without creating or changing
  anything. `ADMIN_ONLY_OPERATION` means it is still disabled in the console.

Once signed in it runs the same reads the pages run, one at a time, and prints
the verdict — rules live or not, which documents this account may read, and
which composite indexes exist. It is safe to run at any time and writes
nothing except a skipped check's note.

## "Unable to sign in" — what that means

Sign-in failures are translated by `friendlyAuthError()` in `js/account.js`,
including the two that used to hide behind a generic message:

* `auth/unauthorized-domain` — Google sign-in from an address not on Firebase's
  authorised-domain list. Add the domain in the console; email/password sign-in
  keeps working either way.
* `auth/admin-restricted-operation` / `auth/operation-not-allowed` — the
  provider is disabled in the console. Enable **Email/Password** (and **Google**)
  under Authentication → Sign-in method.

Registration also no longer dead-ends. It used to report "Unable to create your
account" when the *profile* write failed — even though the login had already
been created — and a retry then hit "email already in use" with no way forward.
Now `ensureUserProfile()` (also in `js/account.js`) creates the profile if it is
missing, is retried automatically by the dashboard and the wallet page, and the
Google button on the register page no longer rewrites an existing profile
(which the security rules rightly refused).

## Layout

| Path | Purpose |
| --- | --- |
| `js/firebase.js` | Firebase app, Auth and Firestore clients, error diagnostics |
| `js/admin.js` | Administrator list, access check, post-login redirect |
| `js/account.js` | Auth error translation, atomic profile/referral creation/repair |
| `referrals.html` | Invitation links, milestones, affiliate applications and sales links |
| `admin-referrals.html` | Verification/fraud review, lifetime rates/claims, affiliate/reward review |
| `js/referral-rewards.js` | Verified review, private audits, held and lifetime reward claims |
| `services.html` / `admin-services.html` | User requests and admin prices/manual fulfilment |
| `js/services.js` | Customer-only social purchases, Gmail rental reserve/finalize/refund |
| `js/installments.js` | Weekly/monthly kobo arithmetic, delivery gates and due-date schedule |
| `js/referrals.js` | Private attribution, applications and atomic reward settlement |
| `js/referral-policy.js` | Agreed naira amounts and commission calculations |
| `setup-check.html` | Reports Authentication config, rules/indexes/session |
| `js/image.js` | Image → base64 helper (receipts, listings, KYC) |
| `firestore.rules` | Server-side access control |
| `scripts/` | Optional Admin SDK helpers |
| `wallet.html` | User wallet: deposit, withdraw, full naira history |
| `admin-wallet.html` | Administrator settlement desk |
| `js/wallet.js` | Ledger, deposits, withdrawals, email sale payouts, settlement |
| `js/data/nigeria.js` | 37 states, 774 LGAs, 48 banks with NIP codes |
| `marketplace.html` | Responsive storefront discovery, search, offers and product details |
| `js/marketplace-page.js` | Storefront filtering, product gallery, wishlist, cart and checkout |
| `css/marketplace.css` | Marketplace theme and responsive storefront styles |
| `sell.html` | Seller verification, paid listings, promotions and sales dashboard |
| `orders.html` | Order tracking for buyers and sellers |
| `admin-marketplace.html` | Verification queue, listings, fees, settlement |
| `js/marketplace.js` | KYC, listings, orders, pricing |
| `css/app.css` | Shared component foundation |
| `css/light-theme.css` | Marketplace-inspired light palette across 20 non-storefront pages |
| `subadmin-desk.html` | The mail desk: claim, verify, complete |
| `admin-team.html` | Promote sub-admins, see who handled what |
| `js/emaildesk.js` | Queue, atomic claim, presence, notifications |
| `js/notifications.js` | Bell, device alerts, live order feed, policy watcher |
| `js/notification-policy.js` | Event catalogue, admin policy merge, alert matching |
| `admin-notifications.html` | Administrator switches and wording for notifications |
| `js/admin-notifications-page.js` | Notification admin form and save/reset/test |
| `js/phone-alerts.js` | Customer-facing phone-alert opt-in (ntfy topic) |
| `scripts/notify-worker.mjs` | Scheduled sender: Firestore → policy → ntfy |
| `.github/workflows/notify-cron.yml` | Runs the sender every five minutes |
| `sw.js` | Notification click handling for Android/desktop |

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
