// Sends Kahekesi push notifications.
// Instant ones react to database changes (requests, answers, shared items, focus, goal);
// the scheduled one sends "starts soon" reminders and the morning summary.
const {onDocumentWritten, onDocumentCreated} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {setGlobalOptions, logger} = require('firebase-functions/v2');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');

initializeApp();
setGlobalOptions({region: process.env.FN_REGION || 'europe-west1', maxInstances: 3, memory: '256MiB'});
const db = getFirestore();

const DEF = {nameA: 'Elshan', nameB: 'Ayan', goalTitle: '', goalTarget: 300, goalSince: 0, tz: 'Europe/Tallinn'};
async function cfg() { const s = await db.doc('config/main').get(); return Object.assign({}, DEF, s.exists ? s.data() : {}); }
const other = p => p === 'a' ? 'b' : 'a';
const nm = (c, p) => p === 'a' ? c.nameA : p === 'b' ? c.nameB : 'Someone';
const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

// Push to every device of the users that pass `pick`, respecting each user's notification settings.
async function push(pick, type, msg) {
  const users = await db.collection('users').get();
  for (const u of users.docs) {
    const d = u.data();
    if (!pick(d, u.id)) continue;
    if (type !== 'test' && d.prefs && d.prefs[type] === false) continue;
    const toks = await u.ref.collection('tokens').get();
    const list = toks.docs.filter(t => t.data().token);
    if (!list.length) continue;
    const res = await getMessaging().sendEachForMulticast({
      tokens: list.map(t => t.data().token),
      data: {title: String(msg.title || 'Kahekesi'), body: String(msg.body || ''), tag: String(msg.tag || type), url: String(msg.url || '/')},
      webpush: {headers: {Urgency: 'high', TTL: '86400'}},
    });
    await Promise.all(res.responses.map((r, i) => {
      if (r.success) return null;
      const code = r.error && r.error.code;
      logger.warn('push failed', {code, user: u.id});
      return DEAD.has(code) ? list[i].ref.delete() : null;
    }));
  }
}
const to = (people, type, msg) => push(d => people.includes(d.me), type, msg);

exports.onItem = onDocumentWritten('items/{id}', async ev => {
  const b = ev.data.before.exists ? ev.data.before.data() : null;
  const a = ev.data.after.exists ? ev.data.after.data() : null;
  if (!a) return;
  const id = ev.params.id, t = a.text || '';
  const c = await cfg();

  if (a.ask === 'pending' && (!b || b.ask !== 'pending') && (a.owner === 'a' || a.owner === 'b')) {
    await to([a.owner], 'ask', {title: nm(c, a.askedBy) + ' asks you', body: t, tag: 'ask-' + id, url: '/?tab=inbox'});
  }
  if (b && b.ask === 'pending' && (a.ask === 'accepted' || a.ask === 'declined') && a.askedBy) {
    await to([a.askedBy], 'answer', {title: nm(c, a.owner) + (a.ask === 'accepted' ? ' accepted' : ' said not now'), body: t, tag: 'ans-' + id, url: '/?tab=inbox'});
  }
  if (!b && (a.createdBy === 'a' || a.createdBy === 'b') && !a.ask && (!a.repeat || a.repeat === 'none')) {
    if (a.kind === 'shopping') await to([other(a.createdBy)], 'shared', {title: nm(c, a.createdBy) + ' added to shopping', body: t, tag: 'shop-' + id, url: '/?tab=shopping'});
    else if (a.owner === 'both') await to([other(a.createdBy)], 'shared', {title: nm(c, a.createdBy) + ' added a together task', body: t, tag: 'tog-' + id, url: '/?tab=todo'});
  }
  if (b && !b.done && a.done && (a.doneBy === 'a' || a.doneBy === 'b')) {
    const shared = a.owner === 'both' || (a.askedBy && a.askedBy !== a.doneBy);
    if (shared && a.kind !== 'shopping') {
      await to([other(a.doneBy)], 'done', {title: nm(c, a.doneBy) + ' finished', body: t + ' (+' + (a.points || 0) + ')', tag: 'done-' + id, url: '/'});
    }
    if (c.goalTitle && c.goalTarget > 0) {
      const all = await db.collection('items').where('done', '==', true).get();
      let tot = 0;
      for (const d of all.docs) { const x = d.data(); if ((x.doneAt || 0) >= (c.goalSince || 0)) tot += Number(x.points) || 0; }
      const before = tot - (Number(a.points) || 0);
      if (before < c.goalTarget && tot >= c.goalTarget) {
        await to(['a', 'b'], 'goal', {title: 'Goal reached: ' + c.goalTitle, body: 'Together you made ' + c.goalTarget + ' points. Go enjoy it!', tag: 'goal', url: '/?tab=rewards'});
      }
    }
  }
});

exports.onStatus = onDocumentWritten('status/{p}', async ev => {
  const p = ev.params.p;
  if (p !== 'a' && p !== 'b') return;
  const b = ev.data.before.exists ? ev.data.before.data() : null;
  const a = ev.data.after.exists ? ev.data.after.data() : null;
  if (!a || !a.text) return;
  if (b && b.text === a.text && (a.at || 0) - (b.at || 0) < 30 * 60e3) return;
  const c = await cfg();
  const mins = a.until ? Math.round((a.until - a.at) / 6e4) : 0;
  await to([other(p)], 'focus', {title: nm(c, p) + ' started focusing', body: a.text + (mins ? ' · ' + mins + ' min' : ''), tag: 'focus-' + p, url: '/'});
});

const BK = {tea: ['🍵', 'Tea'], lunch: ['🍽️', 'Lunch'], walk: ['🚶', 'Walk'], rest: ['😴', 'Rest'], youtube: ['📺', 'YouTube'], scroll: ['📱', 'Scrolling'], game: ['🎮', 'Game']};
const bk = b => BK[b.kind] || ['⏸️', b.label || 'Break'];

exports.onBreak = onDocumentCreated('breaks/{id}', async ev => {
  const b = ev.data && ev.data.data();
  if (!b || b.end || (b.who !== 'a' && b.who !== 'b')) return;
  const c = await cfg(), [e, l] = bk(b);
  await to([other(b.who)], 'breaks', {title: nm(c, b.who) + ' is taking a break', body: e + ' ' + l + (b.planned ? ' · ' + b.planned + ' min' : ''), tag: 'break-' + b.who, url: '/'});
});

exports.onRedeem = onDocumentCreated('redemptions/{id}', async ev => {
  const r = ev.data && ev.data.data();
  if (!r || (r.who !== 'a' && r.who !== 'b')) return;
  const c = await cfg();
  await to([other(r.who)], 'goal', {title: nm(c, r.who) + ' redeemed a reward', body: r.title + ' (−' + r.cost + ' pts)', tag: 'redeem-' + ev.params.id, url: '/?tab=rewards'});
});

exports.onUser = onDocumentWritten('users/{uid}', async ev => {
  const b = ev.data.before.exists ? ev.data.before.data() : {};
  const a = ev.data.after.exists ? ev.data.after.data() : null;
  if (!a || !a.testAt || a.testAt === b.testAt) return;
  await push((d, id) => id === ev.params.uid, 'test', {title: 'Kahekesi works', body: 'Notifications are on for this device. Agla says hi.', tag: 'test'});
});

function local(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(date);
  const g = k => f.find(x => x.type === k).value;
  return {date: g('year') + '-' + g('month') + '-' + g('day'), hm: g('hour') + ':' + g('minute')};
}
function addDays(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const visibleTo = (x, p) => (x.owner === p || x.owner === 'both') && x.ask !== 'pending' && x.ask !== 'declined';

exports.reminders = onSchedule({schedule: 'every 5 minutes', timeZone: 'Europe/Tallinn'}, async () => {
  const c = await cfg();
  let tz = c.tz;
  try { new Intl.DateTimeFormat('en', {timeZone: tz}); } catch (e) { tz = DEF.tz; }
  const now = local(new Date(), tz), soon = local(new Date(Date.now() + 15 * 60e3), tz);
  const until = soon.date === now.date ? soon.hm : '24:00';
  const open = (await db.collection('items').where('done', '==', false).get()).docs;

  for (const d of open) {
    const x = d.data();
    if (x.date !== now.date || !x.start || x.kind === 'shopping') continue;
    if (!(x.start > now.hm && x.start <= until)) continue;
    const key = x.date + ' ' + x.start;
    if (x.remindedFor === key) continue;
    const people = x.owner === 'both' ? ['a', 'b'] : (x.owner === 'a' || x.owner === 'b') && x.ask !== 'pending' && x.ask !== 'declined' ? [x.owner] : [];
    if (!people.length) continue;
    await d.ref.update({remindedFor: key});
    await to(people, 'plan', {title: 'At ' + x.start + ': ' + x.text, body: x.owner === 'both' ? 'Together with ' + nm(c, other(people[0])) : 'Coming up soon', tag: 'plan-' + d.id, url: '/?tab=day'});
  }

  // Break nudges: when a planned break runs out and the app did not already nudge.
  const breaks = (await db.collection('breaks').where('end', '==', null).get()).docs;
  for (const d of breaks) {
    const b = d.data(), due = b.start + (b.planned || 0) * 60e3;
    if (Date.now() - b.start > 4 * 3600e3) { await d.ref.update({end: due > b.start ? due : b.start + 4 * 3600e3, autoEnded: true, nudged: true}); continue; }
    if (!b.planned || b.nudged || Date.now() < due) continue;
    await d.ref.update({nudged: true});
    const [e, l] = bk(b);
    await to([b.who], 'nudge', {title: 'Break is up ' + e, body: 'Your ' + b.planned + ' min ' + l.toLowerCase() + ' break is over. Ready to go back?', tag: 'nudge', url: '/'});
  }

  const stRef = db.doc('notifier/state');
  const st = (await stRef.get()).data() || {};
  if (now.hm >= '08:00' && st.morning !== now.date) {
    await stRef.set({morning: now.date}, {merge: true});
    if (now.hm > '11:00') return; // first run late in the day: skip, start tomorrow
    const tm = addDays(now.date, 1);
    for (const p of ['a', 'b']) {
      const mine = open.map(d => d.data()).filter(x => visibleTo(x, p) && x.kind !== 'shopping');
      const planned = mine.filter(x => x.date === now.date).length;
      const late = mine.filter(x => x.date && x.date < now.date).length;
      const dueToday = mine.filter(x => x.due && x.due <= now.date).length;
      const dueTom = mine.filter(x => x.due === tm).length;
      const parts = [planned ? planned + ' planned today' : null, dueToday ? dueToday + ' due today' : null, dueTom ? dueTom + ' due tomorrow' : null, late ? late + ' left from earlier' : null].filter(Boolean);
      if (!parts.length) continue;
      await to([p], 'morning', {title: 'Good morning, ' + nm(c, p), body: parts.join(' · '), tag: 'morning', url: '/?tab=day'});
    }
  }
});
