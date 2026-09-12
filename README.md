# ViewTube — Production

A working video platform: Firebase Auth, Cloudflare Stream video hosting, Firestore data, and M-Pesa creator monetization. No demo data — every button in the frontend calls the real API.

```
viewtube/
├── index.html              ← Frontend (real API + Firebase Auth, single file)
├── backend/
│   ├── server.js           ← Express API
│   ├── package.json
│   └── .env.example
├── firestore.rules         ← Locks Firestore to backend-only access
├── firestore.indexes.json  ← Composite indexes the API queries need
└── README.md
```

---

## 1. Firebase (~10 min)

1. https://console.firebase.google.com → **Add project** (e.g. `viewtube-prod`)
2. **Build → Firestore Database → Create database** (production mode, `eur3` or `nam5`)
3. **Build → Authentication → Get started** → enable **Google** and **Email/Password**
4. **Project Settings → Service accounts → Generate new private key** → download the JSON
5. **Project Settings → General → Your apps → Add app → Web** → copy the `firebaseConfig` values (apiKey, authDomain, projectId)
6. Under **Authentication → Settings → Authorized domains**, add your frontend domain once deployed

Deploy the rules and indexes (from the project root, one paste):

```bash
sudo npm install -g firebase-tools && firebase login && firebase init firestore --project YOUR_PROJECT_ID && cp firestore.rules firestore.indexes.json . 2>/dev/null; firebase deploy --only firestore --project YOUR_PROJECT_ID
```

If `firebase init` asks about files, keep the `firestore.rules` and `firestore.indexes.json` already in this folder (answer **No** to overwriting).

> Index builds take a few minutes. Until they finish, feed/trending/search return an index error with a direct "create index" link — clicking those links is an alternative to deploying `firestore.indexes.json`.

## 2. Cloudflare Stream (~5 min)

1. https://dash.cloudflare.com → **Stream** → subscribe (from ~$5/mo for 1,000 min storage)
2. Copy your **Account ID** (dashboard sidebar)
3. **My Profile → API Tokens → Create Token** → Custom token with permission **Stream: Edit** → copy the token
4. Optional but recommended: **Stream → Settings → Webhooks** → add `https://YOUR-API/videos/cf-webhook` and copy the signing secret into `CF_WEBHOOK_SECRET`. This flips videos from *processing* to *live* automatically.

## 3. M-Pesa Daraja (optional — payments are disabled cleanly if unset)

Sandbox (testing):
1. https://developer.safaricom.co.ke → create an app → copy **Consumer Key/Secret**
2. Passkey from the **M-Pesa Express (Lipa na M-Pesa Online)** test credentials page
3. `MPESA_ENV=sandbox`, `MPESA_SHORTCODE=174379`

Production (real money):
1. Apply for **Go Live** on the Daraja portal with your Paybill/Till
2. Set `MPESA_ENV=production`, your real shortcode, and the production passkey Safaricom issues
3. `API_URL` must be a public **HTTPS** URL — Safaricom will not call an HTTP callback

## 4. Deploy the backend (Railway)

```bash
cd backend && sudo npm install -g @railway/cli && railway login && railway init && railway up
```

Then in the Railway dashboard → your service → **Variables**, add everything from `.env.example`:
- `FIREBASE_SERVICE_ACCOUNT` — the whole service-account JSON pasted as one line
- `CF_ACCOUNT_ID`, `CF_API_TOKEN`
- `FRONTEND_URL` — your frontend URL(s), comma-separated (locks CORS)
- `API_URL` — the Railway public URL of this service
- M-Pesa vars if using payments

Verify: `curl https://YOUR-API.up.railway.app/health` → `{"status":"ok",...}`

## 5. Deploy the frontend

Open `index.html` and edit the **CONFIG block** at the top of the `<script>` section:

```js
const API_BASE_URL = 'https://YOUR-API.up.railway.app';
const FIREBASE_CONFIG = { apiKey: '...', authDomain: '...', projectId: '...' };
```

Then deploy (Vercel shown; Netlify/Cloudflare Pages work identically):

```bash
sudo npm install -g vercel && vercel --prod
```

Finally: add the deployed domain to Firebase **Authorized domains** (step 1.6) or Google sign-in will be blocked, and set that same domain in the backend's `FRONTEND_URL` variable.

---

## What was fixed vs. the previous version

**Frontend** — was a static demo (hardcoded videos, fake upload progress, fake payments, no auth). Now fully wired:
- Real Firebase Auth (Google + email/password), user doc bootstrap via `/auth/sync`
- Feed, trending, subscriptions, search, channel, studio all load from the API with loading skeletons and empty states
- Real uploads: `POST /videos/upload-url` → direct XHR upload to Cloudflare Stream with true progress → publish
- Real playback via Cloudflare Stream embed; real thumbnails
- Real M-Pesa tips: STK Push + status polling until the payment settles
- All user content HTML-escaped (the old code was XSS-vulnerable)
- Deep links: `?v=VIDEO_ID` opens a video directly

**Backend** — hardened:
- **Bug fix:** `/videos/search` was declared after `/videos/:id`, so search requests matched the wrong route and never worked
- Search no longer downloads the entire collection per query (prefix index + bounded recent scan; swap in Algolia when the catalog is large)
- helmet, rate limiting (strict on payments), CORS locked to `FRONTEND_URL`, request size limits
- Ownership checks on publish/delete; private-video access control; input validation and sanitization everywhere
- Kenyan phone normalization (`07XX` → `2547XX`) and amount bounds on payments
- M-Pesa sandbox/production switch via `MPESA_ENV`; correct local-time timestamp; token caching; idempotent callback (replays can't double-credit earnings)
- Likes/subscribes are Firestore transactions (no drifting counters)
- `/payments/:id/status` endpoint so the frontend can confirm settlement
- Video delete endpoint that also removes the file from Cloudflare Stream
- Optional Cloudflare webhook signature verification (`CF_WEBHOOK_SECRET`)
- Fails fast on missing/invalid env vars with clear messages; structured error handler

## Known limits (honest list)

- **Direct uploads cap at 200MB** (Cloudflare simple upload). Larger files need the TUS resumable protocol — the backend's upload URL already supports it; the frontend would need `tus-js-client`.
- **Search** is prefix + recent-scan, fine to a few thousand videos. Beyond that, wire in Algolia/Typesense.
- **View counts** increment per request (no dedup by viewer).
- **Payouts** to creators (B2C) are recorded in `earnings` but disbursement is manual — Daraja B2C requires a separate approved product.
- **History** is device-local (localStorage), not synced to the account.
- The old `live-streaming/`, `shorts/`, and `mobile-app/` folders were demo scaffolds with fake data and are not part of this production build. They can be built on top of this API when needed.
