// Prepares the Firebase project before each deploy. Every step is safe to repeat.
// Needs GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account key with the Owner role.
// Writes public/firebase-config.js and functions/.env, and prints the app URL.
import {GoogleAuth} from 'google-auth-library';
import {readFileSync, writeFileSync, appendFileSync} from 'node:fs';

const key = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
const PID = key.project_id;
const auth = new GoogleAuth({scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/firebase']});
const client = await auth.getClient();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, url, body, {ok404 = false} = {}) {
  const {token} = await client.getAccessToken();
  const r = await fetch(url, {method, headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-goog-user-project': PID}, body: body ? JSON.stringify(body) : undefined});
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (r.status === 404 && ok404) return null;
  if (!r.ok) throw new Error(method + ' ' + url.split('?')[0] + ' -> ' + r.status + ' ' + (data.error && data.error.message || text).slice(0, 400));
  return data;
}
async function wait(op, base) {
  for (let i = 0; i < 90 && op && !op.done; i++) { await sleep(4000); op = await api('GET', base + '/' + op.name); }
  if (op && op.error) throw new Error('operation failed: ' + JSON.stringify(op.error).slice(0, 400));
  return op;
}
const step = async (name, fn, soft = false) => {
  process.stdout.write('• ' + name + ' … ');
  try { const r = await fn(); console.log('ok'); return r; }
  catch (e) { console.log(soft ? 'skipped' : 'FAILED'); console.log('  ' + e.message); if (!soft) process.exit(1); }
};

console.log('Project: ' + PID);
const proj = await step('read project', () => api('GET', `https://cloudresourcemanager.googleapis.com/v1/projects/${PID}`));
const NUM = proj.projectNumber;

await step('turn on Google Cloud services', async () => {
  const ids = ['firestore.googleapis.com', 'identitytoolkit.googleapis.com', 'firebasehosting.googleapis.com', 'firebaserules.googleapis.com',
    'cloudfunctions.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'run.googleapis.com',
    'eventarc.googleapis.com', 'pubsub.googleapis.com', 'cloudscheduler.googleapis.com', 'fcm.googleapis.com',
    'fcmregistrations.googleapis.com', 'firebaseinstallations.googleapis.com', 'storage.googleapis.com', 'compute.googleapis.com',
    'iam.googleapis.com', 'firebase.googleapis.com', 'logging.googleapis.com'];
  const op = await api('POST', `https://serviceusage.googleapis.com/v1/projects/${NUM}/services:batchEnable`, {serviceIds: ids});
  await wait(op, 'https://serviceusage.googleapis.com/v1');
});

const fsdb = await step('create the database', async () => {
  const base = `https://firestore.googleapis.com/v1/projects/${PID}/databases`;
  let d = await api('GET', base + '/(default)', null, {ok404: true});
  if (!d) {
    const op = await api('POST', base + '?databaseId=(default)', {type: 'FIRESTORE_NATIVE', locationId: 'europe-west1'});
    await wait(op, 'https://firestore.googleapis.com/v1');
    d = await api('GET', base + '/(default)');
  }
  return d;
});
const loc = fsdb.locationId || 'europe-west1';
const REGION = {eur3: 'europe-west1', nam5: 'us-central1', nam7: 'us-central1'}[loc] || loc;
console.log('  database location: ' + loc + ', functions region: ' + REGION);

await step('allow email + password sign-in', () => api('PATCH',
  `https://identitytoolkit.googleapis.com/admin/v2/projects/${PID}/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired`,
  {signIn: {email: {enabled: true, passwordRequired: true}}}), true);

await step('check Google sign-in', async () => {
  const g = await api('GET', `https://identitytoolkit.googleapis.com/admin/v2/projects/${PID}/defaultSupportedIdpConfigs/google.com`, null, {ok404: true});
  if (!g || !g.enabled) throw new Error('Google sign-in is not switched on yet (Firebase console → Authentication → Sign-in method → Google).');
}, true);

const webApp = await step('register the web app', async () => {
  const base = `https://firebase.googleapis.com/v1beta1/projects/${PID}/webApps`;
  const list = await api('GET', base);
  let app = (list.apps || []).find(a => a.state !== 'DELETED');
  if (!app) {
    const op = await api('POST', base, {displayName: 'Kahekesi'});
    const done = await wait(op, 'https://firebase.googleapis.com/v1beta1');
    app = done.response;
  }
  return app;
});
const cfg = await step('read the web app settings', () => api('GET', `https://firebase.googleapis.com/v1beta1/${webApp.name}/config`));

const site = await step('find the hosting site', async () => {
  const base = `https://firebasehosting.googleapis.com/v1beta1/projects/${PID}/sites`;
  const list = await api('GET', base);
  let s = (list.sites || []).find(x => x.type === 'DEFAULT_SITE') || (list.sites || [])[0];
  if (!s) s = await api('POST', base + '?siteId=' + PID, {});
  return s;
});

await step('give the build account its roles', async () => {
  // The build and runtime account, plus the Pub/Sub and Eventarc agents that deliver database events to the functions.
  for (const svc of ['pubsub.googleapis.com', 'eventarc.googleapis.com']) {
    await api('POST', `https://serviceusage.googleapis.com/v1beta1/projects/${NUM}/services/${svc}:generateServiceIdentity`, {}).catch(() => {});
  }
  const compute = `serviceAccount:${NUM}-compute@developer.gserviceaccount.com`;
  const want = [
    [compute, ['roles/cloudbuild.builds.builder', 'roles/logging.logWriter', 'roles/storage.objectViewer', 'roles/artifactregistry.writer', 'roles/run.invoker', 'roles/eventarc.eventReceiver']],
    [`serviceAccount:service-${NUM}@gcp-sa-pubsub.iam.gserviceaccount.com`, ['roles/iam.serviceAccountTokenCreator']],
    [`serviceAccount:service-${NUM}@gcp-sa-eventarc.iam.gserviceaccount.com`, ['roles/eventarc.serviceAgent']],
  ];
  const pol = await api('POST', `https://cloudresourcemanager.googleapis.com/v1/projects/${PID}:getIamPolicy`, {});
  let changed = false;
  for (const [sa, roles] of want) for (const role of roles) {
    let b = pol.bindings.find(x => x.role === role);
    if (!b) { b = {role, members: []}; pol.bindings.push(b); }
    if (!b.members.includes(sa)) { b.members.push(sa); changed = true; }
  }
  if (changed) await api('POST', `https://cloudresourcemanager.googleapis.com/v1/projects/${PID}:setIamPolicy`, {policy: pol});
}, true);

const host = site.defaultUrl ? new URL(site.defaultUrl).host.replace('.web.app', '.firebaseapp.com') : PID + '.firebaseapp.com';
const conf = {apiKey: cfg.apiKey, authDomain: cfg.authDomain || PID + '.firebaseapp.com', projectId: PID, storageBucket: cfg.storageBucket,
  messagingSenderId: cfg.messagingSenderId, appId: cfg.appId};
if (process.env.VAPID_KEY) conf.vapidKey = process.env.VAPID_KEY;
writeFileSync('public/firebase-config.js', '// Written by scripts/bootstrap.mjs at deploy time.\nexport default ' + JSON.stringify(conf, null, 2) + ';\n');
writeFileSync('functions/.env', 'FN_REGION=' + REGION + '\n');
const url = 'https://' + host;
console.log('App URL: ' + url);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `project=${PID}\nurl=${url}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Kahekesi\nOpen: ${url}\n`);
