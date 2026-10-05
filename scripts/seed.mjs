// One-time setup run from the "Deploy" workflow's manual trigger.
// Adds the owner (and optionally the partner) to the allow list and, if the database is still empty,
// imports lists exported from the old claude.ai version. Inputs are read from the workflow event file and never printed.
import {readFileSync} from 'node:fs';
import {initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';

initializeApp();
const db = getFirestore();
const inputs = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).inputs || {};
const owner = (inputs.owner_email || '').trim().toLowerCase();
const partner = (inputs.partner_email || '').trim().toLowerCase();
const seed = (inputs.seed || '').trim();

if (owner) { await db.doc('allow/' + owner).set({role: 'owner', me: 'a', addedAt: Date.now()}, {merge: true}); console.log('owner added'); }
if (partner) { await db.doc('allow/' + partner).set({role: 'member', me: 'b', addedAt: Date.now()}, {merge: true}); console.log('partner added'); }
if (seed) {
  const data = JSON.parse(Buffer.from(seed, 'base64').toString('utf8'));
  const existing = await db.collection('items').limit(1).get();
  if (!existing.empty) console.log('items already exist, import skipped');
  else {
    const batch = db.batch();
    for (const [coll, docs] of Object.entries(data.collections || {})) {
      if (!['items', 'rewards', 'redemptions'].includes(coll)) continue;
      for (const [id, d] of Object.entries(docs)) batch.set(db.collection(coll).doc(id), d);
    }
    if (data.config) batch.set(db.doc('config/main'), data.config, {merge: true});
    await batch.commit();
    console.log('imported old lists');
  }
}
