import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
