import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://uplmvcwtqpvhcclrcjvw.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_gDHUVCzVkOj_is1zBokVMQ_5oXk6Bt-";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// Small compatibility layer used by the existing static pages while they move
// from the previous backend to Supabase.
export const auth = {
  currentUser: null,
  _persistence: "local"
};
export const db = supabase;

function userShape(user) {
  if (!user) return null;
  return {
    ...user,
    uid: user.id,
    displayName: user.user_metadata?.display_name || user.user_metadata?.full_name || "",
    photoURL: user.user_metadata?.avatar_url || ""
  };
}

function authError(error) {
  if (!error) return error;
  const message = (error.message || "").toLowerCase();
  if (message.includes("invalid login")) error.code = "auth/invalid-credential";
  else if (message.includes("already registered") || message.includes("already exists")) error.code = "auth/email-already-in-use";
  else if (message.includes("password")) error.code = "auth/weak-password";
  else error.code ||= "auth/unknown";
  return error;
}

export function initializeApp() { return supabase; }
export function getAuth() { return auth; }
export class GoogleAuthProvider { setCustomParameters() {} }
export const browserLocalPersistence = "local";
export const browserSessionPersistence = "session";
export async function setPersistence(_auth, value) { auth._persistence = value; }

export async function signInWithEmailAndPassword(_auth, email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw authError(error);
  auth.currentUser = userShape(data.user);
  return { user: auth.currentUser };
}
export async function createUserWithEmailAndPassword(_auth, email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw authError(error);
  auth.currentUser = userShape(data.user);
  return { user: auth.currentUser };
}
export async function signInWithPopup() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: new URL("dashboard.html", location.href).href }
  });
  if (error) throw authError(error);
  return { user: auth.currentUser, data };
}
export async function sendPasswordResetEmail(_auth, email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: new URL("login.html", location.href).href
  });
  if (error) throw authError(error);
}
export function onAuthStateChanged(_auth, callback) {
  supabase.auth.getSession().then(({ data }) => {
    auth.currentUser = userShape(data.session?.user);
    callback(auth.currentUser);
  });
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    auth.currentUser = userShape(session?.user);
    callback(auth.currentUser);
  });
  return () => data.subscription.unsubscribe();
}
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  auth.currentUser = null;
}

export function collection(_db, table) { return { table }; }
export function doc(_db, table, id) { return { table, id }; }
export function where(column, operator, value) { return { type: "where", column, operator, value }; }
export function orderBy(column, direction = "asc") { return { type: "order", column, direction }; }
export function query(ref, ...clauses) { return { ...ref, clauses }; }
export function serverTimestamp() { return new Date().toISOString(); }
export function arrayUnion(value) { return { __arrayUnion: value }; }

function applyClauses(builder, clauses = []) {
  for (const clause of clauses) {
    if (clause.type === "where") {
      if (clause.operator !== "==") throw new Error(`Unsupported query operator: ${clause.operator}`);
      builder = builder.eq(clause.column, clause.value);
    } else if (clause.type === "order") {
      builder = builder.order(clause.column, { ascending: clause.direction !== "desc" });
    }
  }
  return builder;
}
function querySnapshot(rows = []) {
  return {
    forEach(fn) { rows.forEach(row => fn({ id: row.id, data: () => row })); }
  };
}
export async function getDocs(ref) {
  const { data, error } = await applyClauses(supabase.from(ref.table).select("*"), ref.clauses);
  if (error) throw error;
  return querySnapshot(data);
}
export async function addDoc(ref, values) {
  const { data, error } = await supabase.from(ref.table).insert(values).select("id").single();
  if (error) throw error;
  return { id: data.id };
}
export async function setDoc(ref, values, options = {}) {
  const row = { ...values, id: ref.id };
  const request = options.merge
    ? supabase.from(ref.table).upsert(row, { onConflict: "id" })
    : supabase.from(ref.table).upsert(row, { onConflict: "id" });
  const { error } = await request;
  if (error) throw error;
}
export async function updateDoc(ref, values) {
  const resolved = { ...values };
  for (const [key, value] of Object.entries(resolved)) {
    if (value?.__arrayUnion !== undefined) {
      const { data, error } = await supabase.from(ref.table).select(key).eq("id", ref.id).single();
      if (error) throw error;
      resolved[key] = [...(data[key] || []), value.__arrayUnion];
    }
  }
  const { error } = await supabase.from(ref.table).update(resolved).eq("id", ref.id);
  if (error) throw error;
}
export function onSnapshot(ref, next, errorHandler = console.error) {
  let active = true;
  const load = async () => {
    try {
      if (ref.id) {
        const { data, error } = await supabase.from(ref.table).select("*").eq("id", ref.id).maybeSingle();
        if (error) throw error;
        if (active) next({ exists: () => Boolean(data), data: () => data });
      } else {
        const { data, error } = await applyClauses(supabase.from(ref.table).select("*"), ref.clauses);
        if (error) throw error;
        if (active) next(querySnapshot(data));
      }
    } catch (error) { errorHandler(error); }
  };
  load();
  const channel = supabase.channel(`realtime:${ref.table}:${ref.id || "all"}:${crypto.randomUUID()}`)
    .on("postgres_changes", { event: "*", schema: "public", table: ref.table, ...(ref.id ? { filter: `id=eq.${ref.id}` } : {}) }, load)
    .subscribe();
  return () => { active = false; supabase.removeChannel(channel); };
}
