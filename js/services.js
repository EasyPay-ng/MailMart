// Reviewed social-asset requests and manual, authorized mailbox rentals.
// No passwords, session cookies, provider secrets, automatic account creation
// or third-party inbox access. Only administrators can settle money/deliver.
import {
  auth, db, doc, getDoc, collection, query, where, orderBy, onSnapshot,
  setDoc, updateDoc, addDoc, runTransaction, serverTimestamp, Timestamp
} from "./firebase.js";
import { roundMoney } from "./referral-policy.js";
import { prepareLifetimeReferral } from "./referral-rewards.js";

export const SOCIAL_PLATFORMS = ["Facebook", "Instagram", "X", "Other"];
export const MIN_CODE_PRICE = 50;
export const SERVICE_STATUS = {
  pending: "Pending review", awaiting_code: "Awaiting code", completed: "Completed",
  rejected: "Rejected", cancelled: "Cancelled", refunded: "Refunded"
};
const rows = (snapshot) => snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
function actor(user) {
  const value = user?.email || user?.uid;
  if (!value) throw new Error("Administrator identity is missing.");
  return value;
}
async function verifiedUser() {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to continue.");
  await user.reload(); await user.getIdToken(true);
  if (!user.emailVerified) throw new Error("Verify your MailMart sign-in email first. You can send a verification email from Referrals.");
  return user;
}
function price(value, minimum = 0) {
  const n = roundMoney(Number(value));
  if (n < minimum || n > 100000000) throw new Error(`Price must be between ₦${minimum} and ₦100,000,000.`);
  return n;
}
function text(value, maximum, label, minimum = 1) {
  const v = String(value || "").trim();
  if (v.length < minimum || v.length > maximum) throw new Error(`${label} must be ${minimum}–${maximum} characters.`);
  return v;
}
function watchCatalog(name, onRows, onError, all) {
  return onSnapshot(query(collection(db, name), orderBy("createdAt", "desc")),
    (snap) => onRows(rows(snap).filter((row) => all || row.active === true)), onError);
}
export function watchSocialOffers(onRows, onError = console.error, all = false) { return watchCatalog("socialOffers", onRows, onError, all); }
export function watchRentalCategories(onRows, onError = console.error, all = false) { return watchCatalog("rentalCategories", onRows, onError, all); }
export function watchServiceRequests(name, onRows, onError = console.error, all = false) {
  if (!["rentals", "socialRequests"].includes(name)) throw new Error("Unknown service.");
  const q = all ? query(collection(db, name), orderBy("createdAt", "desc"))
    : query(collection(db, name), where("uid", "==", auth.currentUser.uid), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}

export async function saveSocialOffer(values, adminUser) {
  const id = values.id || doc(collection(db, "socialOffers")).id;
  const ref = doc(db, "socialOffers", id);
  const previous = await getDoc(ref);
  const platform = String(values.platform);
  if (!SOCIAL_PLATFORMS.includes(platform)) throw new Error("Choose a supported platform.");
  const stock = Number(values.stock);
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) throw new Error("Stock must be a whole number from 0 to 100,000.");
  await setDoc(ref, {
    title: text(values.title, 120, "Offer title"), platform,
    description: text(values.description, 1000, "Description"), buyPrice: price(values.buyPrice), sellPrice: price(values.sellPrice),
    stock, active: values.active === true, authorizedTransfersOnly: true,
    createdAt: previous.exists() ? previous.data().createdAt : serverTimestamp(),
    updatedAt: serverTimestamp(), updatedBy: actor(adminUser)
  });
  return id;
}
export async function saveRentalCategory(values, adminUser) {
  const id = values.id || doc(collection(db, "rentalCategories")).id;
  const ref = doc(db, "rentalCategories", id);
  const previous = await getDoc(ref);
  await setDoc(ref, {
    name: text(values.name, 100, "Category name"), description: text(values.description, 1000, "Description"),
    price: price(values.price, MIN_CODE_PRICE), active: values.active === true, manualOnly: true,
    createdAt: previous.exists() ? previous.data().createdAt : serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: actor(adminUser)
  });
  return id;
}

export async function requestSocial({ offerId, side, accountUrl = "", ownershipNote = "", acceptedTerms, expectedAmount = null }) {
  const user = await verifiedUser();
  if (!["buy", "sell"].includes(side)) throw new Error("Choose whether you are buying or selling.");
  if (acceptedTerms !== true) throw new Error("Confirm ownership/authorization and the transfer terms.");
  const offer = await getDoc(doc(db, "socialOffers", offerId));
  if (!offer.exists() || !offer.data().active) throw new Error("This offer is not available.");
  const data = offer.data();
  const amount = price(side === "buy" ? data.sellPrice : data.buyPrice, 0.01);
  if (expectedAmount !== null && amount !== price(expectedAmount, 0.01)) throw new Error("The admin price changed. Close this form and review the current offer before accepting it.");
  if (side === "buy" && data.stock < 1) throw new Error("This offer is currently out of stock.");
  let url = "";
  if (side === "sell") {
    try { const parsed = new URL(accountUrl); if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.href.length > 1000) throw new Error(); url = parsed.href; }
    catch { throw new Error("Enter the public HTTPS URL of the asset you own."); }
    text(ownershipNote, 1000, "Ownership/authorized-transfer explanation", 10);
  }
  const profile = await getDoc(doc(db, "users", user.uid));
  if (!profile.exists()) throw new Error("Finish setting up your profile first.");
  if (side === "buy" && profile.data().balance < amount) throw new Error("Top up your wallet before requesting this purchase.");
  return addDoc(collection(db, "socialRequests"), {
    uid: user.uid, email: user.email || "", offerId, platform: data.platform, title: data.title,
    side, amount, accountUrl: url, ownershipNote: side === "sell" ? ownershipNote.trim() : "",
    acceptedTerms: true, status: "pending", createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
}

/** Pay the owner or debit a buyer ONLY after an authorized transfer is reviewed. */
export async function completeSocialRequest({ requestId, transferReference, ownershipReviewed, adminUser }) {
  if (ownershipReviewed !== true) throw new Error("Confirm that ownership and the platform-permitted transfer were reviewed.");
  const reference = text(transferReference, 800, "Authorized transfer reference", 5);
  const reviewer = actor(adminUser);
  await runTransaction(db, async (t) => {
    const ref = doc(db, "socialRequests", requestId);
    const snap = await t.get(ref);
    if (!snap.exists() || snap.data().status !== "pending") throw new Error("This request is no longer pending.");
    const request = snap.data();
    const offerRef = doc(db, "socialOffers", request.offerId);
    const offer = await t.get(offerRef);
    const walletRef = doc(db, "users", request.uid);
    const wallet = await t.get(walletRef);
    const ledgerId = "social_" + request.side + "_" + requestId;
    const existing = await t.get(doc(db, "transactions", ledgerId));
    if (existing.exists()) throw new Error("This request has already been settled.");
    if (!offer.exists() || !offer.data().active || !wallet.exists()) throw new Error("The offer or customer account is unavailable.");
    const buying = request.side === "buy";
    if (buying && offer.data().stock < 1) throw new Error("There is no remaining stock.");
    const amount = price(request.amount, 0.01);
    const next = roundMoney(wallet.data().balance + (buying ? -amount : amount));
    if (next < 0) throw new Error("The buyer no longer has sufficient balance. No transfer or charge was recorded.");
    const type = buying ? "social_purchase" : "social_sale";
    const lifetime = await prepareLifetimeReferral(t, { uid: request.uid, profile: wallet.data(), sourceId: ledgerId, type, amount, adminUser });
    t.update(walletRef, { balance: next, updatedAt: serverTimestamp() });
    t.update(offerRef, { stock: offer.data().stock + (buying ? -1 : 1), updatedAt: serverTimestamp(), updatedBy: reviewer });
    t.update(ref, { status: "completed", ownershipReviewed: true, transferReference: reference,
      reviewedBy: reviewer, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    t.set(doc(db, "transactions", ledgerId), {
      type, direction: buying ? "debit" : "credit", status: "completed", uid: request.uid, email: request.email,
      amount, balanceAfter: next, socialRequestId: requestId, reference: request.title,
      reviewedBy: reviewer, reviewedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    lifetime();
  });
}

export async function requestRental({ categoryId, purpose, acceptedTerms, expectedAmount = null }) {
  const user = await verifiedUser();
  if (acceptedTerms !== true) throw new Error("Accept the authorized-use and temporary-inbox terms.");
  const category = await getDoc(doc(db, "rentalCategories", categoryId));
  if (!category.exists() || !category.data().active) throw new Error("This rental category is not available.");
  const amount = price(category.data().price, MIN_CODE_PRICE);
  if (expectedAmount !== null && amount !== price(expectedAmount, MIN_CODE_PRICE)) throw new Error("The per-code price changed. Review the category and accept its current price before requesting it.");
  const wallet = await getDoc(doc(db, "users", user.uid));
  if (!wallet.exists() || wallet.data().balance < amount) throw new Error(`You need at least ₦${amount.toFixed(2)} available for one code.`);
  return addDoc(collection(db, "rentals"), {
    uid: user.uid, email: user.email || "", categoryId, categoryName: category.data().name,
    amount, purpose: text(purpose, 500, "Authorized use/service", 5), acceptedTerms: true,
    status: "pending", createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
}

// Dots and +aliases are the SAME Gmail mailbox. Bind the canonical address to
// one customer and never recycle it across customers (account-recovery risk).
export function canonicalGmail(address) {
  const value = String(address || "").trim().toLowerCase();
  if (!/^[a-z0-9.]+(?:\+[a-z0-9._-]+)?@(gmail\.com|googlemail\.com)$/.test(value)) throw new Error("Enter an authorized Gmail inbox address, not a generated placeholder.");
  const local = value.split("@")[0].split("+")[0].replaceAll(".", "");
  if (!local) throw new Error("Invalid Gmail address.");
  return { address: value, key: "gmail-" + local };
}

/** Reserve exactly one code's quoted price before assigning an inbox. */
export async function assignRental({ rentalId, inbox, authorizedMailbox, adminUser }) {
  if (authorizedMailbox !== true) throw new Error("Confirm authorization to provide this mailbox.");
  const mailbox = canonicalGmail(inbox);
  const reviewer = actor(adminUser);
  await runTransaction(db, async (t) => {
    const ref = doc(db, "rentals", rentalId);
    const snap = await t.get(ref);
    if (!snap.exists() || snap.data().status !== "pending") throw new Error("This rental is no longer pending.");
    const request = snap.data();
    const lockRef = doc(db, "rentalInboxes", mailbox.key);
    const lock = await t.get(lockRef);
    const walletRef = doc(db, "users", request.uid);
    const wallet = await t.get(walletRef);
    const paymentId = "rental_payment_" + rentalId;
    const existing = await t.get(doc(db, "transactions", paymentId));
    if (existing.exists()) throw new Error("This rental has already been funded.");
    if (lock.exists() && (lock.data().ownerUid !== request.uid || (lock.data().activeRentalId && lock.data().activeRentalId !== rentalId))) throw new Error("This mailbox is already bound to another customer or an active rental. Use a different authorized inbox.");
    const amount = price(request.amount, MIN_CODE_PRICE);
    if (!wallet.exists() || wallet.data().balance < amount) throw new Error("The customer no longer has the required balance. No inbox was assigned.");
    const next = roundMoney(wallet.data().balance - amount);
    t.update(walletRef, { balance: next, updatedAt: serverTimestamp() });
    t.set(lockRef, { ownerUid: request.uid, activeRentalId: rentalId, updatedAt: serverTimestamp() });
    t.update(ref, { status: "awaiting_code", inbox: mailbox.address, inboxKey: mailbox.key, authorizedMailbox: true,
      paymentTxId: paymentId, assignedBy: reviewer, assignedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    t.set(doc(db, "transactions", paymentId), {
      type: "rental_payment", direction: "debit", status: "approved", uid: request.uid, email: request.email,
      amount, balanceAfter: next, rentalId, reference: `${request.categoryName} — one code`,
      reviewedBy: reviewer, reviewedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
  });
}

/** Deliver only a code arriving at the assigned, authorized inbox. */
export async function completeRental({ rentalId, code, adminUser }) {
  const value = text(code, 64, "Inbox code", 4);
  if (!/^[A-Za-z0-9 -]+$/.test(value)) throw new Error("Enter only the received code, not an email body or login link.");
  const reviewer = actor(adminUser);
  const expiresAt = Timestamp.fromMillis(Date.now() + 10 * 60 * 1000);
  await runTransaction(db, async (t) => {
    const ref = doc(db, "rentals", rentalId);
    const snap = await t.get(ref);
    if (!snap.exists() || snap.data().status !== "awaiting_code") throw new Error("This rental is not waiting for a code.");
    const request = snap.data();
    const paymentRef = doc(db, "transactions", request.paymentTxId);
    const payment = await t.get(paymentRef);
    const wallet = await t.get(doc(db, "users", request.uid));
    const lockRef = doc(db, "rentalInboxes", request.inboxKey);
    const lock = await t.get(lockRef);
    if (!payment.exists() || payment.data().status !== "approved" || payment.data().uid !== request.uid || payment.data().amount !== request.amount) throw new Error("The reserved code payment is missing or inconsistent.");
    if (!wallet.exists() || !lock.exists() || lock.data().ownerUid !== request.uid || lock.data().activeRentalId !== rentalId) throw new Error("The assigned inbox is inconsistent.");
    const lifetime = await prepareLifetimeReferral(t, { uid: request.uid, profile: wallet.data(), sourceId: request.paymentTxId,
      type: "rental_payment", amount: request.amount, adminUser });
    t.update(paymentRef, { status: "completed", reviewedBy: reviewer, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    t.update(ref, { status: "completed", completedAt: serverTimestamp(), codeExpiresAt: expiresAt,
      reviewedBy: reviewer, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    t.update(lockRef, { activeRentalId: null, updatedAt: serverTimestamp() });
    // Only this short-lived document holds the code. Never put it in an
    // order, referral record, notification, audit ledger or public catalog.
    t.set(doc(db, "rentalCodes", rentalId), { uid: request.uid, rentalId, code: value,
      expiresAt, createdAt: serverTimestamp() });
    lifetime();
  });
}
export async function loadRentalCode(rentalId) {
  const snap = await getDoc(doc(db, "rentalCodes", rentalId));
  if (!snap.exists()) throw new Error("This code has expired or is not available yet.");
  const data = snap.data();
  const expires = data.expiresAt?.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
  if (expires.getTime() <= Date.now()) throw new Error("This code has expired.");
  return data;
}

export async function rejectServiceRequest(name, requestId, reason, adminUser) {
  if (!["socialRequests", "rentals"].includes(name)) throw new Error("Unknown service.");
  const note = text(reason, 500, "Reason");
  const reviewer = actor(adminUser);
  await runTransaction(db, async (t) => {
    const ref = doc(db, name, requestId);
    const snap = await t.get(ref);
    if (!snap.exists()) throw new Error("That request is missing.");
    const data = snap.data();
    if (data.status !== "pending" && !(name === "rentals" && data.status === "awaiting_code")) throw new Error("Only pending or unfulfilled requests can be rejected/refunded.");
    let refund = null;
    if (data.status === "awaiting_code") {
      const walletRef = doc(db, "users", data.uid);
      const wallet = await t.get(walletRef);
      const paymentRef = doc(db, "transactions", data.paymentTxId);
      const payment = await t.get(paymentRef);
      const previous = await t.get(doc(db, "transactions", "rental_refund_" + requestId));
      const lockRef = doc(db, "rentalInboxes", data.inboxKey);
      const lock = await t.get(lockRef);
      if (!wallet.exists() || !payment.exists() || payment.data().status !== "approved" || payment.data().amount !== data.amount || previous.exists() || !lock.exists() || lock.data().activeRentalId !== requestId) throw new Error("The reserved payment cannot be refunded twice or is inconsistent.");
      refund = { walletRef, paymentRef, lockRef, balance: roundMoney(wallet.data().balance + data.amount) };
    }
    t.update(ref, { status: refund ? "refunded" : "rejected", rejectionReason: note,
      reviewedBy: reviewer, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    if (refund) {
      t.update(refund.walletRef, { balance: refund.balance, updatedAt: serverTimestamp() });
      t.update(refund.paymentRef, { status: "refunded", reviewedBy: reviewer, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
      t.update(refund.lockRef, { activeRentalId: null, updatedAt: serverTimestamp() });
      t.set(doc(db, "transactions", "rental_refund_" + requestId), {
        type: "rental_refund", direction: "credit", status: "completed", uid: data.uid, email: data.email,
        amount: data.amount, balanceAfter: refund.balance, rentalId: requestId, reference: note,
        reviewedBy: reviewer, reviewedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
    }
  });
}
export async function cancelServiceRequest(name, requestId) {
  if (!["socialRequests", "rentals"].includes(name)) throw new Error("Unknown service.");
  await updateDoc(doc(db, name, requestId), { status: "cancelled", updatedAt: serverTimestamp() });
}
