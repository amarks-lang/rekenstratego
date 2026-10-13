// ════════════════════════════════════════════════════════════════════
//  Rekenstratego 3.0 — firebase.js
//  Dunne I/O-laag rond de modulaire Firebase SDK (browser, via CDN).
//  Alle spellogica zit in core.js, alle updates worden gebouwd in ops.js.
// ════════════════════════════════════════════════════════════════════
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getDatabase, ref, get, update, onValue, onDisconnect, set, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithPopup, GoogleAuthProvider, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { ROOT, cls, presenceRef } from './ops.js';

// De config is publiek per ontwerp: de beveiliging zit in de database-rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyBQys54m-RdDt5jeeYwM9VyTfVKprY4vu8',
  authDomain: 'rekenstratego.firebaseapp.com',
  databaseURL: 'https://rekenstratego-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'rekenstratego',
  storageBucket: 'rekenstratego.firebasestorage.app',
  messagingSenderId: '616130479633',
  appId: '1:616130479633:web:ac74f8e3513f673a2413b0',
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

/* ─── Auth ─── */
export function currentUser() {
  return new Promise(res => { const off = onAuthStateChanged(auth, u => { off(); res(u); }); });
}
/** Leerkracht: inloggen met Google. */
export async function teacherSignIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return (await signInWithPopup(auth, provider)).user;
}
/** Leerling: onzichtbare anonieme login (blijft bewaard in deze browser). */
export async function studentSignIn() {
  const u = await currentUser();
  if (u) return u;
  return (await signInAnonymously(auth)).user;
}
export const logout = () => signOut(auth);

/* ─── Lezen / schrijven ─── */
export const read = async path => (await get(ref(db, path))).val();
export const apply = updates => update(ref(db), updates);
/** Live luisteren; geeft een functie terug om te stoppen. */
export const listen = (path, cb, onError) => onValue(ref(db, path), s => cb(s.val()), onError);

/** Klascode → cid (of null). */
export const findClass = code => read(`${ROOT}/codes/${String(code).trim()}`);

/** Online-status van een leerling, verdwijnt vanzelf bij sluiten. */
export async function setupPresence(cid, sid) {
  const r = ref(db, presenceRef(cid, sid));
  await onDisconnect(r).remove();
  await set(r, { ts: serverTimestamp() });
}

export { cls, ROOT };
