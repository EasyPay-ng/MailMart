// Referral attribution and administrator-only rewards. No browser user can
// create a reward, promote themselves to affiliate, or edit their referrer.
// Public code lookups contain only a uid and affiliate availability — never a
// users query, private profile, email-sale credential, or delivery address.
import {
  auth, db, doc, getDoc, collection, query, where, orderBy, onSnapshot,
  serverTimestamp, runTransaction
} from "./firebase.js";
import {
  REFERRAL_AMOUNTS, referralCodeFor, normalizeReferralCode, roundMoney, orderRewardPlan
} from "./referral-policy.js";
import { prepareHeldRewards } from "./referral-rewards.js";
export { REFERRAL_AMOUNTS, REWARD_TYPES, referralCodeFor } from "./referral-policy.js";

export const REFERRALS = "referrals";
export const REFERRAL_CODES = "referralCodes";
export const AFFILIATE_APPLICATIONS = "affiliateApplications";
export const AFFILIATE_TERMS_VERSION = "2026-10";

const INVITE_KEY = "mailmart.registrationReferral";
const AFFILIATE_KEY = "mailmart.affiliateCode";
const RETURN_KEY = "mailmart.marketplaceReturn";
const memory = new Map();

// A locked-down/private browser may disable sessionStorage. The in-memory
// fallback still supports registration in the current document; storage
// failures must never prevent somebody from creating an account.
function readSession(key) {
  try { return sessionStorage.getItem(key) || memory.get(key) || ""; }
  catch { return memory.get(key) || ""; }
}
function writeSession(key, value) {
  if (value) memory.set(key, value); else memory.delete(key);
  try {
    if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key);
  } catch { /* memory fallback above */ }
}
function invitation() {
  try { return JSON.parse(readSession(INVITE_KEY) || "null"); }
  catch { return null; }
}

export function captureRegistrationReferral() {
  const code = new URL(location.href).searchParams.get("ref");
  // Don't overwrite an invitation already bound to an incompletely saved
  // account. Its dashboard repair must retain the original attribution.
  if (code !== null && !invitation()?.uid) rememberRegistrationReferral(code);
  return invitation()?.code || "";
}
export function rememberRegistrationReferral(code) {
  const value = normalizeReferralCode(code);
  writeSession(INVITE_KEY, value ? JSON.stringify({ code: value, uid: null }) : "");
}
export function bindRegistrationReferral(user) {
  const pending = invitation();
  if (pending && (!pending.uid || pending.uid === user.uid)) {
    writeSession(INVITE_KEY, JSON.stringify({ code: pending.code, uid: user.uid }));
  }
}
export function clearRegistrationReferral(user) {
  const pending = invitation();
  if (!pending?.uid || pending.uid === user?.uid) writeSession(INVITE_KEY, "");
}
export async function registrationReferrer(user) {
  const pending = invitation();
  if (!pending || pending.uid !== user.uid) return null;
  const resolved = await resolveReferralCode(pending.code);
  if (resolved?.uid === user.uid) throw new Error("You cannot refer yourself.");
  return resolved?.uid || null;
}

export async function resolveReferralCode(code) {
  const value = normalizeReferralCode(code);
  if (!value) return null;
  const snap = await getDoc(doc(db, REFERRAL_CODES, value));
  if (!snap.exists()) throw new Error("That referral code was not found. Check it or leave the field blank.");
  return { code: value, uid: snap.data().uid, affiliateActive: snap.data().affiliateActive === true };
}

export function referralLink(code) {
  const url = new URL("register.html", location.href);
  url.searchParams.set("ref", normalizeReferralCode(code));
  return url.href;
}
export function affiliateLink(code, listingId = "") {
  const url = new URL("marketplace.html", location.href);
  url.searchParams.set("aff", normalizeReferralCode(code));
  if (listingId) url.searchParams.set("item", listingId);
  return url.href;
}

// Attribution is explicit at checkout and lasts only in this browser tab.
// Following another link replaces it; clearing the checkout field removes it.
export function captureAffiliateVisit() {
  const url = new URL(location.href);
  if (url.searchParams.has("aff")) writeSession(AFFILIATE_KEY, url.searchParams.get("aff") || "");
  return readSession(AFFILIATE_KEY);
}
export function rememberAffiliateCode(code) {
  writeSession(AFFILIATE_KEY, normalizeReferralCode(code));
}
export function rememberMarketplaceReturn() {
  // Construct a known local filename, never a user-controlled redirect URL.
  const current = new URL(location.href);
  const params = new URLSearchParams();
  for (const key of ["aff", "item"]) {
    if (current.searchParams.has(key)) params.set(key, current.searchParams.get(key));
  }
  writeSession(RETURN_KEY, "marketplace.html" + (params.size ? "?" + params : ""));
}
export function takeMarketplaceReturn() {
  const value = readSession(RETURN_KEY);
  writeSession(RETURN_KEY, "");
  // Storage is untrusted, too: no absolute URL, traversal, or other page.
  return /^marketplace\.html(?:\?[^#]*)?$/.test(value) ? value : "";
}

export async function ensureReferralCode(user) {
  const code = referralCodeFor(user.uid);
  const codeRef = doc(db, REFERRAL_CODES, code);
  await runTransaction(db, async (t) => {
    const profile = await t.get(doc(db, "users", user.uid));
    const existing = await t.get(codeRef);
    if (!profile.exists()) throw new Error("Finish setting up your profile first.");
    if (existing.exists()) {
      if (existing.data().uid !== user.uid) throw new Error("This code belongs to a different account.");
      return;
    }
    t.set(codeRef, {
      uid: user.uid, affiliateActive: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
  });
  return code;
}

export function watchMyReferrals(onRows, onError = console.error) {
  const uid = requireUser().uid;
  return onSnapshot(query(collection(db, REFERRALS), where("referrerUid", "==", uid), orderBy("joinedAt", "desc")),
    (snap) => onRows(rows(snap)), onError);
}
export function watchMyAffiliateApplication(onValue, onError = console.error) {
  return onSnapshot(doc(db, AFFILIATE_APPLICATIONS, requireUser().uid),
    (snap) => onValue(snap.exists() ? { id: snap.id, ...snap.data() } : null), onError);
}
export function watchAffiliateApplications(onRows, onError = console.error) {
  return onSnapshot(query(collection(db, AFFILIATE_APPLICATIONS), orderBy("createdAt", "desc")),
    (snap) => onRows(rows(snap)), onError);
}
function rows(snap) { return snap.docs.map((d) => ({ id: d.id, ...d.data() })); }
function requireUser() {
  if (!auth.currentUser) throw new Error("Sign in to continue.");
  return auth.currentUser;
}
function actor(adminUser) {
  const value = adminUser?.email || adminUser?.uid;
  if (!value) throw new Error("Administrator identity is missing. Sign in again.");
  return value;
}

export async function applyForAffiliate({ promotionPlan, acceptedTerms }) {
  const user = requireUser();
  await user.reload();
  await user.getIdToken(true);
  if (!user.emailVerified) throw new Error("Verify your email address before applying.");
  const plan = String(promotionPlan || "").trim();
  if (plan.length < 10 || plan.length > 1000) throw new Error("Describe how you will bring sales in 10–1,000 characters.");
  if (acceptedTerms !== true) throw new Error("Accept the affiliate terms to continue.");
  const ref = doc(db, AFFILIATE_APPLICATIONS, user.uid);
  await runTransaction(db, async (t) => {
    const previous = await t.get(ref);
    if (previous.exists() && previous.data().status !== "rejected") {
      throw new Error("Your application is already being reviewed, approved, or suspended.");
    }
    const data = {
      promotionPlan: plan, acceptedTerms: true, termsVersion: AFFILIATE_TERMS_VERSION,
      termsAcceptedAt: serverTimestamp(), status: "pending", updatedAt: serverTimestamp()
    };
    if (previous.exists()) t.update(ref, data);
    else t.set(ref, { ...data, uid: user.uid, email: user.email || "", createdAt: serverTimestamp() });
  });
}

/** Review or suspend an affiliate. Only Firestore administrators may do this. */
export async function reviewAffiliate(uid, status, adminUser, reason = "") {
  if (!["approved", "rejected", "suspended"].includes(status)) throw new Error("Choose a valid affiliate decision.");
  const reviewer = actor(adminUser);
  await runTransaction(db, async (t) => {
    const appRef = doc(db, AFFILIATE_APPLICATIONS, uid);
    const codeRef = doc(db, REFERRAL_CODES, referralCodeFor(uid));
    const app = await t.get(appRef);
    const profile = await t.get(doc(db, "users", uid));
    const code = await t.get(codeRef);
    if (!app.exists() || !profile.exists()) throw new Error("That application or account is missing.");
    const from = app.data().status;
    const allowed = { approved: ["pending", "suspended"], rejected: ["pending"], suspended: ["approved"] };
    if (!allowed[status].includes(from)) throw new Error("That application has already changed. Reload and try again.");
    t.update(appRef, {
      status, rejectionReason: String(reason).trim().slice(0, 500),
      reviewedBy: reviewer, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    const active = status === "approved";
    if (code.exists()) t.update(codeRef, { affiliateActive: active, updatedAt: serverTimestamp() });
    else t.set(codeRef, { uid, affiliateActive: active, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  });
}

function rewardEntry(reward, profile, balanceAfter, source, reviewer) {
  return {
    type: reward.type, direction: "credit", status: "completed", uid: reward.uid,
    email: profile.email || "", amount: reward.amount, balanceAfter,
    reference: reward.reference, ...source,
    reviewedBy: reviewer, reviewedAt: serverTimestamp(),
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  };
}

/**
 * Read/prepare the first paid email-sale bonus inside the SAME transaction as
 * the seller payout. The returned closure writes only; call it after ALL
 * transaction reads. The shared referral marker serialises concurrent sales.
 */
export async function prepareEmailReferralReward(t, { saleId, sellerUid, sellerData, adminUser }) {
  if (!sellerData.referredBy) return () => {};
  const ref = doc(db, REFERRALS, sellerUid);
  const referral = await t.get(ref);
  if (!referral.exists() || referral.data().referrerUid !== sellerData.referredBy) {
    throw new Error("The seller's referral record is missing or inconsistent.");
  }
  const data = referral.data();
  if (data.emailSaleId || data.firstPaidEmailSaleId) return () => {};
  const referrerUid = data.referrerUid;
  if (referrerUid === sellerUid) throw new Error("Self-referrals are not allowed.");
  const reward = {
    id: "email_referral_" + sellerUid, type: "email_referral", uid: referrerUid,
    amount: REFERRAL_AMOUNTS.emailSale, reference: "Invitee's first paid email sale"
  };
  if (data.status !== "approved") {
    const hold = await prepareHeldRewards(t, { rewards: [reward], refereeUid: sellerUid,
      referral: data, sourceKind: "email", sourceId: saleId, adminUser });
    return () => {
      hold();
      t.update(ref, { firstPaidEmailSaleId: saleId, updatedAt: serverTimestamp() });
    };
  }
  const referrerRef = doc(db, "users", referrerUid);
  const ledgerRef = doc(db, "transactions", reward.id);
  const referrer = await t.get(referrerRef);
  const previous = await t.get(ledgerRef);
  if (!referrer.exists()) throw new Error("The referrer's wallet is missing.");
  if (previous.exists()) throw new Error("This email referral has already been paid.");
  const next = roundMoney(referrer.data().balance + reward.amount);
  const reviewer = actor(adminUser);
  return () => {
    t.update(referrerRef, { balance: next, updatedAt: serverTimestamp() });
    t.set(ledgerRef, rewardEntry(reward, referrer.data(), next, { sourceUid: sellerUid, saleId }, reviewer));
    t.update(ref, { firstPaidEmailSaleId: saleId, emailSaleId: saleId, emailRewardPaidAt: serverTimestamp(), updatedAt: serverTimestamp() });
  };
}

/**
 * Release completed-order rewards from the administrator's referral desk.
 * No client-side completion handler can move money. Referral milestones,
 * immutable deterministic ledger rows, every recipient balance, and the
 * order's review marker either ALL commit or ALL roll back.
 */
export async function settleOrderRewards(orderId, adminUser) {
  const reviewer = actor(adminUser);
  return runTransaction(db, async (t) => {
    const orderRef = doc(db, "orders", orderId);
    const snap = await t.get(orderRef);
    if (!snap.exists()) throw new Error("That order no longer exists.");
    const order = { ...snap.data(), id: snap.id };
    if (order.rewardsSettledAt) throw new Error("This order's rewards have already been reviewed.");
    if (order.status !== "completed" || !order.paidAt || (order.paymentMode === "installment" && (order.installmentsPaid !== 12 || roundMoney(order.totalPaid) !== roundMoney(order.total)))) throw new Error("Rewards require a paid, delivered and fully funded order.");
    let referralRef = null;
    let referral = null;
    if (order.referrerUid) {
      referralRef = doc(db, REFERRALS, order.buyerUid);
      const referred = await t.get(referralRef);
      if (!referred.exists()) throw new Error("The buyer's referral record is missing.");
      referral = referred.data();
      // Completion fixes the first order before administrators can choose
      // which reward to release. This cannot be bypassed by reviewing a later
      // order first.
      if (!referral.firstCompletedOrderId) throw new Error("The first completed purchase has not been recorded.");
    }
    const plan = orderRewardPlan(order, referral);
    const held = referral && referral.status !== "approved"
      ? plan.filter((reward) => reward.type !== "affiliate_commission") : [];
    const rewards = held.length ? plan.filter((reward) => reward.type === "affiliate_commission") : plan;
    const applyHeld = held.length ? await prepareHeldRewards(t, { rewards: held, refereeUid: order.buyerUid,
      referral, sourceKind: "order", sourceId: orderId, adminUser }) : () => {};
    const profiles = new Map();
    for (const uid of new Set(rewards.map((r) => r.uid))) {
      const profile = await t.get(doc(db, "users", uid));
      if (!profile.exists()) throw new Error("A reward recipient's wallet is missing.");
      profiles.set(uid, { data: profile.data(), balance: roundMoney(profile.data().balance) });
    }
    for (const reward of rewards) {
      const previous = await t.get(doc(db, "transactions", reward.id));
      if (previous.exists()) throw new Error("A matching reward already exists. Nothing was paid twice.");
    }
    applyHeld();
    // Everything above is read-only except the queued holds. A referrer may also be the affiliate:
    // accumulate that user's credits instead of overwriting their balance.
    for (const reward of rewards) {
      const profile = profiles.get(reward.uid);
      profile.balance = roundMoney(profile.balance + reward.amount);
      t.set(doc(db, "transactions", reward.id), rewardEntry(reward, profile.data, profile.balance,
        { sourceUid: order.buyerUid, orderId }, reviewer));
    }
    for (const [uid, profile] of profiles) {
      t.update(doc(db, "users", uid), { balance: profile.balance, updatedAt: serverTimestamp() });
    }
    const purchaseBonusPaid = rewards.some((r) => r.type === "purchase_referral");
    if (purchaseBonusPaid) t.update(referralRef, {
      purchaseOrderId: orderId, purchaseRewardPaidAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    t.update(orderRef, {
      rewardsSettledAt: serverTimestamp(),
      rewardsSummary: {
        purchaseBonusPaid,
        affiliateAmount: rewards.filter((r) => r.type === "affiliate_commission").reduce((n, r) => n + r.amount, 0)
      },
      updatedAt: serverTimestamp()
    });
    return { rewards, held, total: roundMoney(rewards.reduce((n, r) => n + r.amount, 0)) };
  });
}
