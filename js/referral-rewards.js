// Manual referral verification, anti-abuse review, held rewards and lifetime
// commissions. Every money-moving operation is admin-only in firestore.rules.
import {
  auth, db, doc, collection, query, where, orderBy, onSnapshot,
  runTransaction, serverTimestamp
} from "./firebase.js";
import { roundMoney, lifetimeCommissionFor, LIFETIME_SOURCE_TYPES } from "./referral-policy.js";

export const REFERRAL_CLAIMS = "referralClaims";
export const REFERRAL_STATUS = Object.freeze({
  unverified: "Unverified", pending: "Pending review", approved: "Approved",
  flagged: "Flagged", rejected: "Rejected"
});
const reviewer = (user) => {
  const actor = user?.email || user?.uid;
  if (!actor) throw new Error("Administrator identity is missing.");
  return actor;
};
const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
const blocked = (referral) => ["flagged", "rejected"].includes(referral?.status);

export function watchAllReferrals(onRows, onError = console.error) {
  return onSnapshot(query(collection(db, "referrals"), orderBy("joinedAt", "desc")), (snap) => onRows(rows(snap)), onError);
}
export function watchReferralClaims(onRows, onError = console.error, all = false) {
  const base = collection(db, REFERRAL_CLAIMS);
  const q = all ? query(base, orderBy("createdAt", "desc"))
    : query(base, where("uid", "==", auth.currentUser.uid), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => onRows(rows(snap)), onError);
}
export function watchReferralAudit(onRows, onError = console.error) {
  return onSnapshot(query(collection(db, "referralAudit"), orderBy("createdAt", "desc")), (snap) => onRows(rows(snap)), onError);
}
export function watchOwnReferral(user, onValue, onError = console.error) {
  return onSnapshot(doc(db, "referrals", user.uid), (snap) => onValue(snap.exists() ? snap.data() : null), onError);
}

// The server checks email_verified on the actual Firebase ID token. A browser
// cannot mark an unverified account verified or remove a fraud flag.
export async function syncReferralVerification(user) {
  if (!user?.emailVerified) return;
  await user.getIdToken(true);
  await runTransaction(db, async (t) => {
    const ref = doc(db, "referrals", user.uid);
    const snap = await t.get(ref);
    if (!snap.exists()) return;
    if (snap.data().verifiedAt) return;
    const status = snap.data().status || "unverified";
    t.update(ref, { ...(status === "unverified" ? { status: "pending" } : {}), verifiedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  });
}

export async function reviewReferral({ refereeUid, status, ratePercent, reason = "", riskReason = "", privateNote = "", adminUser }) {
  if (!["approved", "flagged", "rejected", "pending"].includes(status)) throw new Error("Choose a valid review decision.");
  const rate = Number(ratePercent);
  if (!Number.isFinite(rate) || rate < 4 || rate > 5) throw new Error("The lifetime commission rate must be between 4% and 5%.");
  if (["flagged", "rejected"].includes(status) && !String(reason).trim()) throw new Error("Give a reason for flagging or rejecting this referral.");
  if (riskReason && !["spam", "bot", "duplicate", "abuse", "other"].includes(riskReason)) throw new Error("Choose a valid risk category.");
  const actor = reviewer(adminUser);
  await runTransaction(db, async (t) => {
    const ref = doc(db, "referrals", refereeUid);
    const snap = await t.get(ref);
    if (!snap.exists()) throw new Error("That referral no longer exists.");
    if (status === "approved" && !snap.data().verifiedAt) throw new Error("The invitee must verify their sign-in email before this referral is approved.");
    t.update(ref, {
      status, lifetimeRatePercent: roundMoney(rate), reviewReason: String(reason).trim().slice(0, 500), riskReason,
      reviewedBy: actor, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    // Private review notes are never placed on the referrer's readable record.
    t.set(doc(collection(db, "referralAudit")), {
      refereeUid, referrerUid: snap.data().referrerUid, fromStatus: snap.data().status || "unverified",
      status, ratePercent: roundMoney(rate), riskReason, publicReason: String(reason).trim().slice(0, 500),
      privateNote: String(privateNote).trim().slice(0, 1000), reviewedBy: actor, createdAt: serverTimestamp()
    });
  });
}

/** Read-only preparation, then a writes-only closure: safe to compose with a payout. */
export async function prepareHeldRewards(t, { rewards, refereeUid, referral, sourceKind, sourceId, adminUser }) {
  if (blocked(referral)) return () => {};
  const pending = [];
  for (const reward of rewards) {
    const claimRef = doc(db, REFERRAL_CLAIMS, reward.id);
    const existing = await t.get(claimRef);
    const ledger = await t.get(doc(db, "transactions", reward.id));
    if (!existing.exists() && !ledger.exists()) pending.push({ ref: claimRef, reward });
  }
  const actor = reviewer(adminUser);
  return () => {
    for (const { ref, reward } of pending) t.set(ref, {
      type: reward.type, uid: reward.uid, refereeUid, referrerUid: referral.referrerUid,
      sourceKind, sourceId, sourceType: "", amount: reward.amount, baseAmount: 0, ratePercent: 0,
      reference: reward.reference, status: "pending", createdBy: actor,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
  };
}

/**
 * One lifetime claim per real settled ledger row. Credits and debits are both
 * eligible, but deposits, withdrawals, refunds and rewards themselves are not.
 * No expiry and no downline/rewards-on-rewards recursion. Claims retain the
 * event's rate; admin rate changes affect future events, not paid history.
 */
export async function prepareLifetimeReferral(t, { uid, profile, sourceId, type, amount, adminUser }) {
  if (!profile?.referredBy || !LIFETIME_SOURCE_TYPES.includes(type)) return () => {};
  const ref = await t.get(doc(db, "referrals", uid));
  if (!ref.exists() || ref.data().referrerUid !== profile.referredBy) throw new Error("The referral attribution is inconsistent.");
  if (blocked(ref.data())) return () => {};
  const rate = ref.data().lifetimeRatePercent ?? 4;
  const value = lifetimeCommissionFor(amount, rate);
  if (value <= 0) return () => {};
  const claimRef = doc(db, REFERRAL_CLAIMS, "lifetime_" + sourceId);
  const previous = await t.get(claimRef);
  if (previous.exists()) return () => {};
  const actor = reviewer(adminUser);
  return () => t.set(claimRef, {
    type: "lifetime_commission", uid: ref.data().referrerUid, referrerUid: ref.data().referrerUid,
    refereeUid: uid, sourceKind: "transaction", sourceId, sourceType: type,
    baseAmount: roundMoney(amount), ratePercent: rate, amount: value,
    reference: `${rate}% lifetime referral — ${type.replaceAll("_", " ")}`,
    status: "pending", createdBy: actor, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
}

function claimIds(first) {
  return ["purchase_referral", "purchase_welcome"].includes(first.type)
    ? ["purchase_referral_" + first.refereeUid, "purchase_welcome_" + first.refereeUid] : [first.id];
}
async function sourceIsEligible(t, claim, referral) {
  if (claim.sourceKind === "email") {
    const source = await t.get(doc(db, "sales", claim.sourceId));
    if (!source.exists() || source.data().status !== "paid" || source.data().uid !== claim.refereeUid ||
        (referral.firstPaidEmailSaleId || referral.emailSaleId) !== claim.sourceId) throw new Error("The first paid email sale does not match this reward.");
    if (claim.amount !== 200 || claim.type !== "email_referral") throw new Error("The email reward amount is invalid.");
    return { saleId: claim.sourceId };
  }
  if (claim.sourceKind === "order") {
    const source = await t.get(doc(db, "orders", claim.sourceId));
    if (!source.exists() || source.data().status !== "completed" || !source.data().paidAt ||
        source.data().buyerUid !== claim.refereeUid || referral.firstCompletedOrderId !== claim.sourceId ||
        (source.data().paymentMode === "installment" && (source.data().installmentsPaid !== 12 || roundMoney(source.data().totalPaid) !== roundMoney(source.data().total)))) {
      throw new Error("This purchase is not paid, completed and eligible.");
    }
    if (referral.purchaseOrderId) throw new Error("The first-purchase bonus has already been paid.");
    return { orderId: claim.sourceId, order: source.data() };
  }
  if (claim.sourceKind !== "transaction" || claim.type !== "lifetime_commission") throw new Error("Unknown reward source.");
  const source = await t.get(doc(db, "transactions", claim.sourceId));
  if (!source.exists()) throw new Error("The source transaction is missing.");
  const tx = source.data();
  if (tx.status !== "completed" || tx.uid !== claim.refereeUid || tx.type !== claim.sourceType ||
      !LIFETIME_SOURCE_TYPES.includes(tx.type) || tx.amount !== claim.baseAmount ||
      lifetimeCommissionFor(tx.amount, claim.ratePercent) !== claim.amount) throw new Error("The lifetime commission does not match a settled activity.");
  // A debit or seller payout alone is not a fulfilled sale. Do not release
  // commissions for cancelled/refunded orders or unfinished instalment plans.
  for (const [field, name] of [["orderId", "orders"], ["socialRequestId", "socialRequests"], ["rentalId", "rentals"]]) {
    if (!tx[field]) continue;
    const business = await t.get(doc(db, name, tx[field]));
    if (!business.exists() || business.data().status !== "completed") throw new Error("This activity is still awaiting fulfilment or has been cancelled/refunded.");
    if (name === "orders" && business.data().paymentMode === "installment" && business.data().installmentsPaid !== 12) throw new Error("All 12 instalments must be paid before commission release.");
  }
  if (tx.type === "email_payout") {
    if (!tx.saleId) throw new Error("The paid email sale reference is missing.");
    const sale = await t.get(doc(db, "sales", tx.saleId));
    if (!sale.exists() || sale.data().status !== "paid" || sale.data().uid !== tx.uid || sale.data().payout !== tx.amount) throw new Error("The email payout no longer matches an approved paid sale.");
  }
  return { sourceTxId: claim.sourceId };
}

/** Purchase referrer and buyer bonuses are released as an atomic pair. */
export async function releaseReferralClaim(claimId, adminUser) {
  const actor = reviewer(adminUser);
  return runTransaction(db, async (t) => {
    const first = await t.get(doc(db, REFERRAL_CLAIMS, claimId));
    if (!first.exists()) throw new Error("That reward no longer exists.");
    const initial = { id: first.id, ...first.data() };
    const refRef = doc(db, "referrals", initial.refereeUid);
    const ref = await t.get(refRef);
    if (!ref.exists() || ref.data().status !== "approved" || !ref.data().verifiedAt) throw new Error("Approve this verified referral before releasing rewards.");
    const claims = [];
    for (const id of claimIds(initial)) {
      const snap = id === initial.id ? first : await t.get(doc(db, REFERRAL_CLAIMS, id));
      if (!snap.exists() || snap.data().status !== "pending") throw new Error("This reward group is not pending or has already been reviewed.");
      const claim = { id, ...snap.data() };
      if (claim.refereeUid !== initial.refereeUid || claim.sourceId !== initial.sourceId || claim.referrerUid !== ref.data().referrerUid) throw new Error("The reward group is inconsistent.");
      if (claim.type !== "purchase_welcome" && claim.uid !== ref.data().referrerUid) throw new Error("The recipient does not match the referral.");
      if (claim.type === "purchase_welcome" && (claim.uid !== claim.refereeUid || claim.amount !== 200)) throw new Error("The buyer reward is invalid.");
      if (claim.type === "purchase_referral" && claim.amount !== 500) throw new Error("The purchase referral amount is invalid.");
      claims.push(claim);
    }
    if (["purchase_referral", "purchase_welcome"].includes(initial.type) &&
        (claims[0].type !== "purchase_referral" || claims[1].type !== "purchase_welcome" || claims.some((c) => c.sourceKind !== "order"))) throw new Error("The purchase reward pair is inconsistent.");
    const source = await sourceIsEligible(t, initial, ref.data());
    const profiles = new Map();
    for (const uid of new Set(claims.map((claim) => claim.uid))) {
      const snap = await t.get(doc(db, "users", uid));
      if (!snap.exists()) throw new Error("A reward recipient's wallet is missing.");
      profiles.set(uid, { data: snap.data(), balance: roundMoney(snap.data().balance) });
    }
    for (const claim of claims) {
      const old = await t.get(doc(db, "transactions", claim.id));
      if (old.exists()) throw new Error("A matching reward ledger entry already exists. Nothing was paid twice.");
    }
    // All reads above; all writes below.
    for (const claim of claims) {
      const wallet = profiles.get(claim.uid);
      wallet.balance = roundMoney(wallet.balance + claim.amount);
      const sourceFields = source.orderId ? { orderId: source.orderId } : source;
      t.set(doc(db, "transactions", claim.id), {
        type: claim.type, direction: "credit", status: "completed", uid: claim.uid, email: wallet.data.email || "",
        amount: claim.amount, balanceAfter: wallet.balance, reference: claim.reference,
        sourceUid: claim.refereeUid, claimId: claim.id, ...sourceFields,
        ...(claim.type === "lifetime_commission" ? { baseAmount: claim.baseAmount, ratePercent: claim.ratePercent } : {}),
        reviewedBy: actor, reviewedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      t.update(doc(db, REFERRAL_CLAIMS, claim.id), { status: "completed", reviewedBy: actor, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }
    for (const [uid, wallet] of profiles) t.update(doc(db, "users", uid), { balance: wallet.balance, updatedAt: serverTimestamp() });
    if (initial.type === "email_referral") t.update(refRef, { emailSaleId: initial.sourceId, emailRewardPaidAt: serverTimestamp(), updatedAt: serverTimestamp() });
    if (["purchase_referral", "purchase_welcome"].includes(initial.type)) {
      t.update(refRef, { purchaseOrderId: initial.sourceId, purchaseRewardPaidAt: serverTimestamp(), updatedAt: serverTimestamp() });
      t.update(doc(db, "orders", initial.sourceId), {
        rewardsSettledAt: serverTimestamp(), rewardsSummary: { ...source.order.rewardsSummary, purchaseBonusPaid: true }, updatedAt: serverTimestamp()
      });
    }
    return { total: roundMoney(claims.reduce((sum, claim) => sum + claim.amount, 0)), count: claims.length };
  });
}

export async function rejectReferralClaim(claimId, reason, adminUser) {
  const actor = reviewer(adminUser);
  if (!String(reason).trim()) throw new Error("Enter a reason for rejecting this reward.");
  await runTransaction(db, async (t) => {
    const initial = await t.get(doc(db, REFERRAL_CLAIMS, claimId));
    if (!initial.exists()) throw new Error("That reward no longer exists.");
    const claims = [];
    for (const id of claimIds({ id: initial.id, ...initial.data() })) {
      const snap = await t.get(doc(db, REFERRAL_CLAIMS, id));
      if (!snap.exists() || snap.data().status !== "pending") throw new Error("Only pending rewards can be rejected.");
      claims.push(id);
    }
    for (const id of claims) t.update(doc(db, REFERRAL_CLAIMS, id), {
      status: "rejected", rejectionReason: String(reason).trim().slice(0, 500), reviewedBy: actor,
      reviewedAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
  });
}
