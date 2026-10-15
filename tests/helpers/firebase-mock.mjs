// Execute the real browser business modules without network or production
// Firebase. This mock rejects Query reads and read-after-write transactions,
// rolls back a failed commit, and retries concurrent document conflicts.
// Security-rule coverage lives separately in firestore.rules.test.mjs.
import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";

export async function createApp(seed = {}, options = {}) {
  const root = path.resolve(import.meta.dirname, "../..");
  const store = new Map(Object.entries(structuredClone(seed)));
  const versions = new Map();
  const storage = new Map();
  let autoId = 0;
  let clock = 10000;
  let failPath = null;
  const stats = { commits: 0, retries: 0 };
  const db = {};
  const auth = { currentUser: options.user || null };
  function ref(pathname) { return { kind: "doc", path: pathname, id: pathname.split("/").at(-1) }; }
  function collection(_db, name) { return { kind: "collection", path: name }; }
  function doc(...args) {
    if (args[0]?.kind === "collection") return ref(args[0].path + "/auto-" + (++autoId));
    return ref(args.slice(1).join("/"));
  }
  function snapshot(r, source = store) {
    const value = source.get(r.path);
    return { id: r.id, ref: r, exists: () => value !== undefined, data: () => structuredClone(value) };
  }
  function materialize(value, previous, now) {
    if (value?.__stamp) return now;
    if (Object.prototype.toString.call(value) === "[object Date]") return new Date(value.getTime());
    if (value?.__union) return [...(previous || []), ...value.values];
    if (Array.isArray(value)) return value.map((v) => materialize(v, undefined, now));
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, materialize(v, previous?.[k], now)]));
    return value;
  }
  async function runTransaction(_db, operation) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const reads = new Map();
      const writes = [];
      const tx = {
        async get(r) {
          if (r?.kind !== "doc") throw new Error("Transaction.get requires a DocumentReference, not a Query.");
          if (writes.length) throw new Error("All transaction reads must precede writes.");
          const result = snapshot(r);
          reads.set(r.path, versions.get(r.path) || 0);
          await Promise.resolve(); // let concurrent transactions interleave
          return result;
        },
        set(r, value) { writes.push({ kind: "set", r, value }); },
        update(r, value) { writes.push({ kind: "update", r, value }); }
      };
      const result = await operation(tx);
      if ([...reads].some(([key, version]) => (versions.get(key) || 0) !== version)) {
        stats.retries++;
        continue;
      }
      const next = new Map(store);
      const now = ++clock;
      for (const write of writes) {
        if (write.r.path === failPath) throw new Error("Simulated commit refusal");
        if (write.kind === "update" && !next.has(write.r.path)) throw new Error("Missing update target");
        const previous = next.get(write.r.path);
        const data = materialize(write.value, previous, now);
        next.set(write.r.path, write.kind === "update" ? { ...previous, ...data } : data);
      }
      for (const write of writes) {
        store.set(write.r.path, next.get(write.r.path));
        versions.set(write.r.path, (versions.get(write.r.path) || 0) + 1);
      }
      stats.commits++;
      return result;
    }
    throw new Error("Too many transaction conflicts");
  }
  async function getDocs(q) {
    let docs = [...store.keys()].filter((key) => key.startsWith(q.path + "/") && key.split("/").length === 2)
      .map((key) => snapshot(ref(key)));
    for (const condition of q.conditions || []) {
      if (condition.kind === "where") docs = docs.filter((d) => d.data()[condition.key] === condition.value);
      if (condition.kind === "orderBy") docs.sort((a, b) => {
        const av = a.data()[condition.key]; const bv = b.data()[condition.key];
        return (av < bv ? -1 : av > bv ? 1 : 0) * (condition.direction === "desc" ? -1 : 1);
      });
    }
    return { docs, empty: !docs.length, size: docs.length };
  }
  const api = {
    db, auth, doc, collection, runTransaction,
    Timestamp: { fromMillis: (ms) => new Date(ms) },
    getDoc: async (r) => snapshot(r), getDocs,
    serverTimestamp: () => ({ __stamp: true }), arrayUnion: (...values) => ({ __union: true, values }),
    query: (c, ...conditions) => ({ kind: "query", path: c.path, conditions }),
    where: (key, _op, value) => ({ kind: "where", key, value }),
    orderBy: (key, direction) => ({ kind: "orderBy", key, direction }),
    onSnapshot: () => () => {},
    setDoc: async (r, data) => runTransaction(db, (t) => { t.set(r, data); }),
    updateDoc: async (r, data) => runTransaction(db, (t) => { t.update(r, data); }),
    addDoc: async (c, data) => { const r = doc(c); await runTransaction(db, (t) => { t.set(r, data); }); return r; },
    writeBatch: () => {
      const ops = [];
      return {
        set: (r, value) => ops.push(["set", r, value]), update: (r, value) => ops.push(["update", r, value]),
        commit: () => runTransaction(db, (t) => { for (const [kind, r, value] of ops) t[kind](r, value); })
      };
    },
    firestoreErrorHtml: () => "error"
  };
  const context = vm.createContext({
    console, URL, URLSearchParams, setTimeout, clearTimeout,
    location: new URL(options.url || "https://example.com/MailMart/register.html"),
    window: { location: {} },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key)
    }
  });
  const firebase = new vm.SyntheticModule(Object.keys(api), function () {
    for (const [key, value] of Object.entries(api)) this.setExport(key, value);
  }, { context, identifier: path.join(root, "js/firebase.js") });
  const modules = new Map([[firebase.identifier, firebase]]);
  async function getModule(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const module = new vm.SourceTextModule(await fs.readFile(filename, "utf8"), { context, identifier: filename });
    modules.set(filename, module);
    return module;
  }
  async function load(filename) {
    const module = await getModule(path.join(root, filename));
    if (module.status === "unlinked") await module.link((specifier, parent) => getModule(path.resolve(path.dirname(parent.identifier), specifier)));
    if (module.status === "linked") await module.evaluate();
    return module.namespace;
  }
  return {
    load, auth, stats, context, storage,
    data: (key) => structuredClone(store.get(key)),
    all: () => Object.fromEntries(structuredClone([...store])),
    failOn: (key) => { failPath = key; }
  };
}

export const admin = { uid: "admin", email: "baasituoppor01@gmail.com" };
export function profile(uid, balance = 0, referredBy = null) {
  return { uid, username: uid, displayName: uid, phone: "08030000000", email: uid + "@example.com",
    photoURL: "", balance, status: "active", isAdmin: false, referredBy, referralCode: "MM-" + uid,
    createdAt: 1, updatedAt: 1 };
}
export function referral(refereeUid = "buyer", referrerUid = "referrer", extra = {}) {
  return { refereeUid, referrerUid, displayName: refereeUid, joinedAt: 1, updatedAt: 1,
    status: "approved", verifiedAt: 1, lifetimeRatePercent: 4, reviewReason: "", riskReason: "", firstPaidEmailSaleId: null,
    emailSaleId: null, emailRewardPaidAt: null, firstCompletedOrderId: null, firstPurchaseCompletedAt: null,
    purchaseOrderId: null, purchaseRewardPaidAt: null, ...extra };
}
export function order(id = "one", extra = {}) {
  return { id, buyerUid: "buyer", buyerEmail: "buyer@example.com", sellerUid: "seller", sellerEmail: "seller@example.com",
    referrerUid: "referrer", affiliateUid: "affiliate", affiliateCode: "MM-affiliate", paymentTxId: "payment-" + id,
    listingTitle: "Discounted goods", subtotal: 1000, deliveryFee: 300, serviceFee: 50, total: 1350, sellerPayout: 1300,
    status: "completed", paidAt: 5, completedAt: 6, rewardsSettledAt: null, timeline: [], ...extra };
}
