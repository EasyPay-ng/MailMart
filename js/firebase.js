// MailMart — Firebase client (replaces the previous Supabase-backed module).
//
// Every page already calls Firestore-shaped helpers (doc, collection, query,
// onSnapshot, arrayUnion, serverTimestamp) and Firebase-shaped auth helpers
// (signInWithEmailAndPassword, GoogleAuthProvider, onAuthStateChanged), so the
// page code binds straight to the real Firebase Web SDK with almost no change.
//
// The values below are *browser* configuration. A Firebase web apiKey is not a
// secret — it identifies the project, it does not authorise anyone. Real access
// control lives in firestore.rules, which is enforced on Google's servers.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import {
  getAnalytics,
  isSupported as analyticsIsSupported
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyCc-0Gtmh7dIFWgnWglIQfjq-PlJu07IKE",
  authDomain: "mailmartz.firebaseapp.com",
  projectId: "mailmartz",
  storageBucket: "mailmartz.firebasestorage.app",
  messagingSenderId: "802413654231",
  appId: "1:802413654231:web:4e5d87d23d6a2317724092",
  measurementId: "G-LKLEWS7RPF"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

// Analytics is optional and unsupported in some embedded browsers, so a failure
// here must never take sign-in down with it.
export let analytics = null;
analyticsIsSupported()
  .then((supported) => {
    if (supported) analytics = getAnalytics(app);
  })
  .catch(() => {});

export {
  app,
  initializeApp,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  signOut,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  arrayUnion
};

// Collection names, so pages never hard-code them.
export const USERS = "users";
export const SALES = "sales";
