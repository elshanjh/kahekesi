# Kahekesi

Shared lists, plans and rewards for two people, with Agla the cat. An installable web app (PWA) on Firebase with push notifications.

## How it fits together

| Part | Where |
|---|---|
| The app (one page) | `public/index.html` |
| Sign-in, database link, notification settings | `public/kk-firebase.js` |
| Shows notifications on the phone | `public/sw.js` |
| Who may read and write | `firestore.rules` (only emails in the `allow` collection) |
| Sends notifications | `functions/index.js` |
| Prepares the Firebase project | `scripts/bootstrap.mjs` |
| Deploys on every push to `main` | `.github/workflows/deploy.yml` |

`public/firebase-config.js` is generated during deploy and is not in git.

## Deploying

Pushing to `main` deploys. The workflow needs one repository secret, `FIREBASE_SERVICE_ACCOUNT`: the JSON key of the project's
`firebase-adminsdk` service account, with the Owner role. The project must be on the Blaze plan for the notification functions.

To add people or import data once, run the **Deploy** workflow by hand (Actions → Deploy → Run workflow) and fill in the inputs.
The owner can also add the partner's email in the app under Settings → People.

## Notifications

- Instant: a request from the other person, their answer, new shopping or together items, finished shared tasks, focus started, goal reached, reward redeemed.
- Scheduled (every 5 minutes): 15 minutes before a planned time, and a morning summary at 8:00 in the time zone saved in `config/main.tz`.

Each person picks which ones they want in Settings. On iPhone, notifications work only after adding the app to the Home Screen (iOS 16.4 or newer).
