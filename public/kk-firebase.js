// Connects the Kahekesi page to Firebase: sign-in gate, the shared database and push notifications.
// index.html waits for the `kk-db` event and then talks to the small adapter below,
// which keeps the same shape the page used when it ran as a claude.ai artifact.
import config from './firebase-config.js';
import {initializeApp} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, setDoc, updateDoc, deleteDoc,
  onSnapshot, getDoc} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {getMessaging, getToken, isSupported} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js';

const $ = id => document.getElementById(id);
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k]; if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
    else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

const app = initializeApp(config);
const auth = initializeAuth(app, {persistence: [indexedDBLocalPersistence, browserLocalPersistence], popupRedirectResolver: browserPopupRedirectResolver});
const fs = initializeFirestore(app, {ignoreUndefinedProperties: true, localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})});

let started = false, me = null, uid = null, role = null;
const names = {a: 'Elshan', b: 'Ayan'};
const other = p => p === 'a' ? 'b' : 'a';

/* ---------- the adapter index.html uses ---------- */
const wrapDoc = ref => ({
  set: d => setDoc(ref, d),
  update: d => updateDoc(ref, d),
  delete: () => deleteDoc(ref),
  onSnapshot: (cb, err) => onSnapshot(ref, s => cb({id: s.id, exists: s.exists(), data: () => s.data()}), err),
});
const kkDb = {
  collection: c => ({
    doc: id => wrapDoc(doc(fs, c, id)),
    onSnapshot: (cb, err) => onSnapshot(collection(fs, c), s => cb({docs: s.docs.map(d => ({id: d.id, data: () => d.data()}))}), err),
  }),
  doc: path => wrapDoc(doc(fs, path)),
};
function ready(db) {
  if (started) return; started = true;
  window.kkDb = db;
  window.dispatchEvent(new CustomEvent('kk-db', {detail: db}));
}

/* ---------- sign-in gate ---------- */
const gate = $('gate');
{ const f = $('face'); if (f) $('gFace').innerHTML = f.innerHTML.replace(/"cf"/g, '"cg"').replace(/#cf\)/g, '#cg)'); }
const say = (msg, err) => el('p', {class: err ? 'gerr' : 'gmsg', text: msg});
const errText = e => {
  const c = e && e.code || '';
  if (c.includes('popup-closed') || c.includes('cancelled-popup')) return 'Sign-in was closed before it finished.';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'That email and password do not match. Try again, or reset the password.';
  if (c.includes('email-already-in-use')) return 'This email already has an account. Sign in instead, or use "Forgot password" to set one.';
  if (c.includes('weak-password')) return 'Use at least 6 characters for the password.';
  if (c.includes('invalid-email')) return 'That email address does not look right.';
  if (c.includes('network')) return 'No connection. Check the internet and try again.';
  if (c.includes('too-many-requests')) return 'Too many tries. Wait a minute and try again.';
  return 'Something went wrong (' + (c || 'unknown') + '). Try again.';
};

function showSignIn(msg, err) {
  gate.hidden = false;
  const email = el('input', {class: 'field', type: 'email', autocomplete: 'email', placeholder: 'Email', 'aria-label': 'Email'});
  const pass = el('input', {class: 'field', type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': 'Password'});
  const out = el('div');
  const busy = async (fn) => { out.replaceChildren(say('One moment…')); try { await fn(); } catch (e) { out.replaceChildren(say(errText(e), true)); } };
  const google = async () => {
    const p = new GoogleAuthProvider(); p.setCustomParameters({prompt: 'select_account'});
    try { await signInWithPopup(auth, p); }
    catch (e) {
      const c = e && e.code || '';
      if (c.includes('popup-blocked') || c.includes('operation-not-supported') || c.includes('web-storage-unsupported')) await signInWithRedirect(auth, p);
      else throw e;
    }
  };
  const form = el('form', {onsubmit: e => { e.preventDefault(); busy(() => signInWithEmailAndPassword(auth, email.value.trim(), pass.value)); }},
    email, pass,
    el('button', {class: 'btn', type: 'submit', text: 'Sign in with email'}),
    el('button', {class: 'btn ghost', type: 'button', text: 'Create a password account', onclick: () => busy(async () => {
      const r = await createUserWithEmailAndPassword(auth, email.value.trim(), pass.value);
      await sendEmailVerification(r.user);
    })}),
    el('button', {class: 'glink', type: 'button', text: 'Forgot password', onclick: () => busy(async () => {
      if (!email.value.trim()) { out.replaceChildren(say('Type your email first.', true)); return; }
      await sendPasswordResetEmail(auth, email.value.trim());
      out.replaceChildren(say('Check your email for a link to set a new password.'));
    })}));
  $('gBody').replaceChildren(...[
    msg ? say(msg, err) : null,
    el('button', {class: 'btn', text: 'Continue with Google', onclick: () => busy(google)}),
    el('p', {class: 'gor', text: 'or, if Google sign-in does not open on this phone'}),
    form, out].filter(Boolean));
}

function showVerify(user) {
  gate.hidden = false;
  const out = el('div');
  $('gBody').replaceChildren(
    say('We sent a link to ' + user.email + '. Open it, then come back and tap the button below.'),
    el('button', {class: 'btn', text: "I've confirmed my email", onclick: async () => {
      await user.reload(); await user.getIdToken(true);
      if (auth.currentUser.emailVerified) enter(auth.currentUser); else out.replaceChildren(say('Not confirmed yet. Check your inbox and spam folder.', true));
    }}),
    el('button', {class: 'btn ghost', text: 'Send the link again', onclick: async () => { try { await sendEmailVerification(user); out.replaceChildren(say('Sent.')); } catch (e) { out.replaceChildren(say(errText(e), true)); } }}),
    el('button', {class: 'glink', text: 'Use another account', onclick: () => signOut(auth)}),
    out);
}

function showNotAllowed(user) {
  gate.hidden = false;
  $('gBody').replaceChildren(
    say('You are signed in as ' + user.email + ', but this account has not been added to Kahekesi yet.'),
    say('Ask ' + names.a + ' to open Settings → People and add this email. Then tap Try again.'),
    el('button', {class: 'btn', text: 'Try again', onclick: () => enter(user)}),
    el('button', {class: 'btn ghost', text: 'Use another account', onclick: () => signOut(auth)}));
}

async function enter(user) {
  $('gBody').replaceChildren(say('Opening your lists…'));
  const email = (user.email || '').toLowerCase();
  let allow;
  try { allow = await getDoc(doc(fs, 'allow', email)); }
  catch (e) {
    if (e && e.code === 'permission-denied') return showNotAllowed(user);
    if (!started) { ready(null); gate.hidden = true; } // offline and nothing cached: let the page say so
    return;
  }
  if (!allow.exists()) return showNotAllowed(user);
  const a = allow.data();
  role = a.role || 'member'; uid = user.uid;
  let u = null;
  try { const s = await getDoc(doc(fs, 'users', uid)); u = s.exists() ? s.data() : null; } catch (e) {}
  me = (u && (u.me === 'a' || u.me === 'b')) ? u.me : (a.me === 'b' ? 'b' : 'a');
  window.kkMe = me;
  window.kkUid = uid;
  setDoc(doc(fs, 'users', uid), {email, me, updatedAt: Date.now()}, {merge: true}).catch(() => {});
  onSnapshot(doc(fs, 'config', 'main'), s => {
    const c = s.exists() ? s.data() : {};
    names.a = c.nameA || 'Elshan'; names.b = c.nameB || 'Ayan';
    if (!c.tz) { try { setDoc(doc(fs, 'config', 'main'), {tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Tallinn'}, {merge: true}).catch(() => {}); } catch (e) {} }
  }, () => {});
  gate.hidden = true;
  ready(kkDb);
  refreshToken();
  if (role === 'owner') watchPeople();
}

window.kkSetMe = p => { me = p; if (uid) setDoc(doc(fs, 'users', uid), {me: p, updatedAt: Date.now()}, {merge: true}).catch(() => {}); };

getRedirectResult(auth).catch(e => showSignIn(errText(e), true));
onAuthStateChanged(auth, user => {
  if (!user) { if (started) location.reload(); else showSignIn(); return; }
  const pw = user.providerData.some(p => p.providerId === 'password') && !user.providerData.some(p => p.providerId === 'google.com');
  if (pw && !user.emailVerified) return showVerify(user);
  if (!started) enter(user);
});

/* ---------- push notifications ---------- */
const PREFS = [
  ['ask', o => 'When ' + names[o] + ' asks you to do something'],
  ['answer', o => 'When ' + names[o] + ' answers your request'],
  ['shared', o => 'When ' + names[o] + ' adds shopping or a together task'],
  ['done', o => 'When ' + names[o] + ' finishes something you share'],
  ['focus', o => 'When ' + names[o] + ' starts focusing'],
  ['breaks', o => 'When ' + names[o] + ' takes a break'],
  ['nudge', () => 'When my break time is up'],
  ['plan', () => '15 minutes before something you planned'],
  ['morning', () => 'Morning summary at 8:00'],
  ['goal', () => 'Shared goal reached and rewards redeemed'],
];
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function swReg() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  return reg;
}
async function saveToken() {
  if (!(await isSupported())) throw Object.assign(new Error('unsupported'), {code: 'unsupported'});
  const reg = await swReg();
  const opts = {serviceWorkerRegistration: reg};
  if (config.vapidKey) opts.vapidKey = config.vapidKey;
  const token = await getToken(getMessaging(app), opts);
  if (!token || !uid) return null;
  const id = token.replace(/[^A-Za-z0-9_-]/g, '').slice(-200);
  await setDoc(doc(fs, 'users', uid, 'tokens', id), {token, at: Date.now(), ua: navigator.userAgent.slice(0, 160)});
  try { localStorage.setItem('kahekesi.pushId', id); } catch (e) {}
  return token;
}
async function refreshToken() {
  try { if ('Notification' in window && Notification.permission === 'granted') await saveToken(); } catch (e) {}
}

let prefs = {}, prefsUnsub = null;
function drawPush() {
  const box = $('pushBox'); if (!box || !uid) return;
  const o = other(me);
  const msg = el('p', {class: 'gmsg', style: 'text-align:left'});
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const kids = [el('span', {text: 'Notifications on this device'})];
  if (isIOS && !standalone) kids.push(el('p', {class: 'gmsg', style: 'text-align:left',
    text: 'On iPhone, notifications only work from the Home Screen app. In Safari tap Share, then "Add to Home Screen", open Kahekesi from there and turn them on.'}));
  else if (perm === 'unsupported') kids.push(el('p', {class: 'gmsg', style: 'text-align:left', text: 'This browser cannot show notifications.'}));
  else if (perm === 'denied') kids.push(el('p', {class: 'gmsg', style: 'text-align:left', text: 'Notifications are blocked for Kahekesi. Allow them in the phone or browser settings, then reopen the app.'}));
  else if (perm !== 'granted') kids.push(el('button', {type: 'button', class: 'btn', text: 'Turn on notifications', onclick: async () => {
    msg.textContent = 'One moment…';
    try {
      const r = await Notification.requestPermission();
      if (r !== 'granted') { drawPush(); return; }
      await saveToken(); drawPush();
    } catch (e) { msg.textContent = 'Could not turn them on (' + (e.code || e.message) + ').'; }
  }}));
  else kids.push(el('div', {class: 'r'}, el('span', {class: 'pill ok', text: 'On for this device'}),
    el('button', {type: 'button', class: 'btn ghost small', text: 'Send a test', onclick: async () => {
      msg.textContent = 'Sending…';
      try { await saveToken(); await setDoc(doc(fs, 'users', uid), {testAt: Date.now()}, {merge: true}); msg.textContent = 'Sent. It should arrive in a few seconds.'; }
      catch (e) { msg.textContent = 'Could not send (' + (e.code || e.message) + ').'; }
    }})));
  kids.push(msg);
  kids.push(el('span', {text: 'Tell me'}));
  kids.push(...PREFS.map(([k, label]) => el('label', {class: 'pref'},
    el('input', {type: 'checkbox', checked: prefs[k] !== false, onchange: e => {
      prefs = Object.assign({}, prefs, {[k]: e.target.checked});
      setDoc(doc(fs, 'users', uid), {prefs}, {merge: true}).catch(() => {});
    }}), label(o))));
  box.replaceChildren(...kids);
}
function watchPrefs() {
  if (prefsUnsub || !uid) return;
  prefsUnsub = onSnapshot(doc(fs, 'users', uid), s => { prefs = (s.exists() && s.data().prefs) || {}; if (!$('setSheet').hidden) drawPush(); }, () => {});
}

/* ---------- people (owner only) ---------- */
let people = [];
function watchPeople() {
  onSnapshot(collection(fs, 'allow'), s => { people = s.docs.map(d => Object.assign({email: d.id}, d.data())); if (!$('setSheet').hidden) drawPeople(); }, () => {});
}
function drawPeople() {
  const box = $('peopleBox'); if (!box) return;
  if (role !== 'owner') { box.replaceChildren(); return; }
  const input = el('input', {class: 'field', type: 'email', placeholder: names.b + "'s email for signing in", 'aria-label': 'Email to add', style: 'flex:1'});
  const out = el('p', {class: 'gmsg', style: 'text-align:left'});
  box.replaceChildren(
    el('span', {text: 'People who can open Kahekesi'}),
    el('div', {class: 'plist'}, people.map(p => el('div', {class: 'step'},
      el('span', {text: p.email + ' · ' + names[p.me === 'b' ? 'b' : 'a']}),
      p.role === 'owner' ? null : el('button', {type: 'button', class: 'x', 'aria-label': 'Remove ' + p.email, text: '×', onclick: () => deleteDoc(doc(fs, 'allow', p.email)).catch(() => {})})))),
    el('div', {class: 'r'}, input, el('button', {type: 'button', class: 'btn ghost small', text: 'Add as ' + names.b, onclick: async () => {
      const e = input.value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { out.textContent = 'Type a full email address.'; return; }
      try { await setDoc(doc(fs, 'allow', e), {role: 'member', me: 'b', addedAt: Date.now()}); input.value = ''; out.textContent = 'Added. ' + names.b + ' can sign in now.'; }
      catch (err) { out.textContent = 'Could not add (' + (err.code || err.message) + ').'; }
    }})),
    out);
}

$('meBtn').addEventListener('click', () => { watchPrefs(); drawPush(); drawPeople(); });
