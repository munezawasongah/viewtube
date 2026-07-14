// ═══════════════════════════════════════════════════════════════
// VIEWTUBE BACKEND — Production
// Node.js + Express + Firebase Admin + Cloudflare Stream + M-Pesa
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

// ─── Env validation (fail fast, clear message) ──────────────────
const REQUIRED_ENV = ['FIREBASE_SERVICE_ACCOUNT', 'CF_ACCOUNT_ID', 'CF_API_TOKEN'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isAdmin(user) { return !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase()); }

const MPESA_ENABLED = !!(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET && process.env.MPESA_SHORTCODE && process.env.MPESA_PASSKEY);
if (!MPESA_ENABLED) console.warn('WARN: M-Pesa env vars not set — payment routes will return 503.');

const MPESA_BASE = process.env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// ─── Firebase Init ──────────────────────────────────────────────
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('FATAL: FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the full service-account JSON as a single line.');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ─── App setup ──────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // Railway/most PaaS run behind a proxy
app.use(helmet());

const allowedOrigins = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin/no-origin (mobile apps, curl, M-Pesa callbacks)
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
}));
app.use(express.json({ limit: '1mb' }));

// Global rate limit + stricter limit for payment initiation
app.use(rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
const paymentLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

// ─── Helpers ────────────────────────────────────────────────────
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/stream`;
const cfHeaders = { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' };

async function getUploadUrl(maxDurationSeconds = 630, creatorId) {  // 10 min + 30s grace
  const res = await axios.post(`${CF_BASE}/direct_upload`, {
    maxDurationSeconds,
    requireSignedURLs: false,
    meta: { creatorId },
  }, { headers: cfHeaders });
  return res.data.result; // { uid, uploadURL }
}

async function getCFVideo(uid) {
  const res = await axios.get(`${CF_BASE}/${encodeURIComponent(uid)}`, { headers: cfHeaders });
  return res.data.result;
}

async function deleteCFVideo(uid) {
  await axios.delete(`${CF_BASE}/${encodeURIComponent(uid)}`, { headers: cfHeaders });
}

// Normalize Kenyan phone numbers to 2547XXXXXXXX / 2541XXXXXXXX
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  let p = digits;
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  if (!/^254(7|1)\d{8}$/.test(p)) return null;
  return p;
}

function sanitizeText(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLen);
}

const VALID_CATEGORIES = ['Tech', 'Music', 'Gaming', 'Education', 'Sports', 'Comedy', 'News', 'Travel', 'Food', 'Other'];
const VALID_VISIBILITY = ['public', 'unlisted', 'private'];

// Generate a unique @username from a display name (transactional claim)
async function claimUsername(displayName, uid) {
  const base = (String(displayName).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15) || 'creator');
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = attempt === 0 ? base : base + Math.floor(100 + Math.random() * 9900);
    const claimRef = db.collection('usernames').doc(candidate);
    try {
      const ok = await db.runTransaction(async tx => {
        const doc = await tx.get(claimRef);
        if (doc.exists) return false;
        tx.set(claimRef, { uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        return true;
      });
      if (ok) return candidate;
    } catch { /* retry */ }
  }
  return base + Date.now().toString().slice(-6);
}

// Fire-and-forget notification creation
function notify(userId, type, text, refId) {
  if (!userId) return;
  db.collection('notifications').add({
    userId, type, text: String(text).slice(0, 200), refId: refId || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});
}

// Async route wrapper so thrown errors hit the error handler
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── M-Pesa helpers ─────────────────────────────────────────────
let mpesaTokenCache = { token: null, expiresAt: 0 };
async function getMpesaToken() {
  if (mpesaTokenCache.token && Date.now() < mpesaTokenCache.expiresAt) return mpesaTokenCache.token;
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  mpesaTokenCache = { token: res.data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return mpesaTokenCache.token;
}

async function stkPush({ phone, amount, reference, desc }) {
  const token = await getMpesaToken();
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');

  const res = await axios.post(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`, {
    BusinessShortCode: process.env.MPESA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.ceil(amount),
    PartyA: phone,
    PartyB: process.env.MPESA_SHORTCODE,
    PhoneNumber: phone,
    CallBackURL: `${process.env.API_URL}/mpesa/callback`,
    AccountReference: reference.slice(0, 12),
    TransactionDesc: desc.slice(0, 13),
  }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

function requireMpesa(req, res, next) {
  if (!MPESA_ENABLED) return res.status(503).json({ error: 'Payments are not configured on this server' });
  if (!process.env.API_URL) return res.status(503).json({ error: 'API_URL is not configured — M-Pesa callback URL cannot be built' });
  next();
}

// ─── Auth middleware ────────────────────────────────────────────
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth — attaches req.user if a valid token is present
async function optionalAuth(req, _res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (token) {
    try { req.user = await admin.auth().verifyIdToken(token); } catch { /* ignore */ }
  }
  next();
}

// ═══════════════════════════════════════════════════════════════
// AUTH / USER BOOTSTRAP
// ═══════════════════════════════════════════════════════════════

// Called by the frontend after sign-in; creates the user doc on first login
app.post('/auth/sync', authMiddleware, wrap(async (req, res) => {
  const userRef = db.collection('users').doc(req.user.uid);
  const doc = await userRef.get();
  if (!doc.exists) {
    const displayName = req.user.name || req.user.email?.split('@')[0] || 'Creator';
    const username = await claimUsername(displayName, req.user.uid);
    await userRef.set({
      displayName,
      displayNameLower: displayName.toLowerCase(),
      username,
      email: req.user.email || null,
      photoURL: req.user.picture || null,
      coverURL: null,
      bio: '',
      subscriberCount: 0,
      videoCount: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  const fresh = await userRef.get();
  // Backfill searchable lowercase name for existing users
  if (fresh.exists && !fresh.data().displayNameLower && fresh.data().displayName) {
    await userRef.update({ displayNameLower: fresh.data().displayName.toLowerCase() });
  }
  if (fresh.exists && !fresh.data().username) {
    const uname = await claimUsername(fresh.data().displayName || 'creator', req.user.uid);
    await userRef.update({ username: uname });
  }
  res.json({ id: fresh.id, ...fresh.data() });
}));

// Search platform users by name (for starting conversations)
app.get('/users/search', authMiddleware, wrap(async (req, res) => {
  const q = sanitizeText(req.query.q, 50).toLowerCase();
  if (!q) return res.json({ users: [] });
  // Prefix query on displayNameLower PLUS a scan fallback: orderBy silently excludes
  // docs missing the field (users created before that field existed), so the scan
  // catches them by matching displayName directly.
  const [prefixSnap, scanSnap] = await Promise.all([
    db.collection('users').orderBy('displayNameLower').startAt(q).endAt(q + '\uf8ff').limit(10).get(),
    db.collection('users').limit(300).get(),
  ]);
  const seen = new Map();
  prefixSnap.docs.forEach(d => seen.set(d.id, d));
  scanSnap.docs.forEach(d => {
    if (seen.has(d.id)) return;
    if ((d.data().displayName || '').toLowerCase().includes(q)) seen.set(d.id, d);
  });
  res.json({ users: [...seen.values()]
    .filter(d => d.id !== req.user.uid)
    .slice(0, 10)
    .map(d => ({ id: d.id, displayName: d.data().displayName || 'User' })) });
}));

// ═══════════════════════════════════════════════════════════════
// VIDEOS
// NOTE: static routes (/feed, /trending, /search) MUST be declared
// before /videos/:id or Express matches them as an :id.
// ═══════════════════════════════════════════════════════════════

app.post('/videos/upload-url', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const result = await getUploadUrl(630, req.user.uid);
  await db.collection('videos').doc(result.uid).set({
    cloudflareUid: result.uid,
    uploaderId: req.user.uid,
    status: 'uploading',
    visibility: 'private',
    views: 0,
    likes: 0,
    commentCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  res.json({ uploadURL: result.uploadURL, uid: result.uid });
}));

app.post('/videos/:uid/publish', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const { uid } = req.params;
  const videoRef = db.collection('videos').doc(uid);
  const doc = await videoRef.get();
  if (!doc.exists) return res.status(404).json({ error: 'Video not found' });
  if (doc.data().uploaderId !== req.user.uid) return res.status(403).json({ error: 'You do not own this video' });

  const title = sanitizeText(req.body.title, 120);
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const description = sanitizeText(req.body.description, 5000);
  const category = VALID_CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
  const visibility = VALID_VISIBILITY.includes(req.body.visibility) ? req.body.visibility : 'public';
  const tags = Array.isArray(req.body.tags)
    ? req.body.tags.slice(0, 15).map(t => sanitizeText(String(t), 30).toLowerCase()).filter(Boolean)
    : [];

  const userDoc = await db.collection('users').doc(req.user.uid).get();
  const cfVideo = await getCFVideo(uid);

  // Enforce 10-minute maximum (Cloudflare also enforces via maxDurationSeconds)
  if (cfVideo.duration && cfVideo.duration > 605) {
    await deleteCFVideo(uid).catch(() => {});
    await videoRef.delete().catch(() => {});
    return res.status(400).json({ error: 'Videos must be 10 minutes or shorter. This upload was removed.' });
  }

  let customThumb = null;
  if (req.body.thumbImageId) {
    customThumb = await verifyOwnImage(req.body.thumbImageId, req.user.uid);
    if (!customThumb) return res.status(400).json({ error: 'Invalid thumbnail image' });
  }
  await videoRef.update({
    title,
    titleLower: title.toLowerCase(),
    description,
    category,
    tags,
    visibility,
    channelName: userDoc.data()?.displayName || 'Creator',
    channelPhotoURL: userDoc.data()?.photoURL || null,
    channelUsername: userDoc.data()?.username || null,
    thumbnailUrl: customThumb || cfVideo.thumbnail || null,
    duration: cfVideo.duration || 0,
    status: cfVideo.readyToStream ? 'live' : 'processing',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection('users').doc(req.user.uid).set({
    videoCount: admin.firestore.FieldValue.increment(1),
  }, { merge: true });
  res.json({ success: true, uid });
}));

// Cloudflare Stream webhook — video finished processing.
// Set CF_WEBHOOK_SECRET and configure the same secret in the Cloudflare
// dashboard to enable signature verification.
app.post('/videos/cf-webhook', wrap(async (req, res) => {
  if (process.env.CF_WEBHOOK_SECRET) {
    const sigHeader = req.headers['webhook-signature'] || '';
    const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
    if (!parts.time || !parts.sig1) return res.status(401).json({ error: 'Missing signature' });
    const expected = crypto.createHmac('sha256', process.env.CF_WEBHOOK_SECRET)
      .update(`${parts.time}.${JSON.stringify(req.body)}`).digest('hex');
    const a = Buffer.from(expected); const b = Buffer.from(parts.sig1);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Bad signature' });
    }
  }
  const { uid, readyToStream, thumbnail, duration } = req.body || {};
  if (uid && readyToStream) {
    const ref = db.collection('videos').doc(uid);
    const doc = await ref.get();
    if (doc.exists && doc.data().status !== 'uploading') {
      await ref.update({ status: 'live', thumbnailUrl: doc.data().thumbnailUrl || thumbnail || null, duration: duration || doc.data().duration || 0 });
    }
  }
  res.json({ ok: true });
}));

app.get('/videos/feed', wrap(async (req, res) => {
  const { category, lastDoc } = req.query;
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  let q = db.collection('videos')
    .where('status', '==', 'live')
    .where('visibility', '==', 'public');
  if (category && category !== 'All' && VALID_CATEGORIES.includes(category)) q = q.where('category', '==', category);
  q = q.orderBy('createdAt', 'desc').limit(limit);
  if (lastDoc) {
    const cursor = await db.collection('videos').doc(String(lastDoc)).get();
    if (cursor.exists) q = q.startAfter(cursor);
  }
  const snap = await q.get();
  const videos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ videos, hasMore: videos.length === limit });
}));

app.get('/videos/trending', wrap(async (req, res) => {
  const snap = await db.collection('videos')
    .where('status', '==', 'live')
    .where('visibility', '==', 'public')
    .orderBy('views', 'desc')
    .limit(20).get();
  res.json({ videos: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
}));

app.get('/videos/search', wrap(async (req, res) => {
  const q = sanitizeText(req.query.q, 100).toLowerCase();
  if (!q) return res.json({ videos: [] });
  // Firestore prefix search on titleLower + recent-scan for contains.
  // For full-text search at scale, plug in Algolia/Typesense here.
  const [prefixSnap, recentSnap] = await Promise.all([
    db.collection('videos')
      .where('status', '==', 'live').where('visibility', '==', 'public')
      .orderBy('titleLower').startAt(q).endAt(q + '\uf8ff').limit(20).get(),
    db.collection('videos')
      .where('status', '==', 'live').where('visibility', '==', 'public')
      .orderBy('createdAt', 'desc').limit(300).get(),
  ]);
  const seen = new Map();
  prefixSnap.docs.forEach(d => seen.set(d.id, { id: d.id, ...d.data() }));
  recentSnap.docs.forEach(d => {
    if (seen.has(d.id)) return;
    const v = d.data();
    const hay = `${v.titleLower || ''} ${v.description || ''} ${(v.tags || []).join(' ')} ${(v.channelName || '')}`.toLowerCase();
    if (hay.includes(q)) seen.set(d.id, { id: d.id, ...v });
  });
  res.json({ videos: [...seen.values()].slice(0, 20) });
}));

app.get('/videos/:id', optionalAuth, wrap(async (req, res) => {
  const doc = await db.collection('videos').doc(req.params.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Not found' });
  const v = doc.data();
  if (v.visibility === 'private' && v.uploaderId !== req.user?.uid) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Self-heal: if Firestore still says processing, re-check Cloudflare
  if (v.status === 'processing') {
    try {
      const cf = await getCFVideo(v.cloudflareUid || doc.id);
      if (cf.readyToStream) {
        const patch = { status: 'live', thumbnailUrl: v.thumbnailUrl || cf.thumbnail || null, duration: cf.duration || v.duration || 0 };
        await doc.ref.update(patch);
        Object.assign(v, patch);
      }
    } catch {}
  }
  // NOTE: views are no longer incremented on fetch — see POST /videos/:id/view
  let liked = false, subscribed = false, myReaction = null;
  if (req.user) {
    const [likeDoc, subDoc, reactDoc] = await Promise.all([
      db.collection('likes').doc(`${req.user.uid}_${doc.id}`).get(),
      db.collection('subscriptions').doc(`${req.user.uid}_${v.uploaderId}`).get(),
      db.collection('reactions').doc(`${req.user.uid}_${doc.id}`).get(),
    ]);
    liked = likeDoc.exists; subscribed = subDoc.exists;
    myReaction = reactDoc.exists ? reactDoc.data().type : null;
  }
  const channelDoc = await db.collection('users').doc(v.uploaderId).get();
  res.json({ id: doc.id, ...v, liked, subscribed, myReaction, channel: channelDoc.exists ? { id: channelDoc.id, displayName: channelDoc.data().displayName, username: channelDoc.data().username || null, subscriberCount: channelDoc.data().subscriberCount || 0, photoURL: channelDoc.data().photoURL || null } : null });
}));

app.get('/videos/:id/related', wrap(async (req, res) => {
  const doc = await db.collection('videos').doc(req.params.id).get();
  if (!doc.exists) return res.json({ videos: [] });
  const { category } = doc.data();
  const snap = await db.collection('videos')
    .where('status', '==', 'live').where('visibility', '==', 'public')
    .where('category', '==', category)
    .orderBy('views', 'desc').limit(11).get();
  res.json({ videos: snap.docs.filter(d => d.id !== req.params.id).slice(0, 10).map(d => ({ id: d.id, ...d.data() })) });
}));

const REACTION_TYPES = ['fire', 'laugh', 'love', 'wow', 'clap'];

app.post('/videos/:id/react', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const type = req.body.type;
  if (!REACTION_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid reaction' });
  const videoRef = db.collection('videos').doc(req.params.id);
  const videoDoc = await videoRef.get();
  if (!videoDoc.exists) return res.status(404).json({ error: 'Video not found' });
  const reactRef = db.collection('reactions').doc(`${req.user.uid}_${req.params.id}`);
  const result = await db.runTransaction(async tx => {
    const existing = await tx.get(reactRef);
    if (existing.exists && existing.data().type === type) {
      // same reaction again = remove it
      tx.delete(reactRef);
      tx.update(videoRef, { [`reactions.${type}`]: admin.firestore.FieldValue.increment(-1) });
      return null;
    }
    if (existing.exists) {
      // switch reaction
      tx.update(videoRef, { [`reactions.${existing.data().type}`]: admin.firestore.FieldValue.increment(-1) });
    }
    tx.set(reactRef, { userId: req.user.uid, videoId: req.params.id, type, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(videoRef, { [`reactions.${type}`]: admin.firestore.FieldValue.increment(1) });
    return type;
  });
  res.json({ myReaction: result });
}));

app.post('/videos/:id/like', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const videoRef = db.collection('videos').doc(req.params.id);
  const videoDoc = await videoRef.get();
  if (!videoDoc.exists) return res.status(404).json({ error: 'Video not found' });
  const likeRef = db.collection('likes').doc(`${req.user.uid}_${req.params.id}`);
  const result = await db.runTransaction(async tx => {
    const likeDoc = await tx.get(likeRef);
    if (likeDoc.exists) {
      tx.delete(likeRef);
      tx.update(videoRef, { likes: admin.firestore.FieldValue.increment(-1) });
      return false;
    }
    tx.set(likeRef, { userId: req.user.uid, videoId: req.params.id, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(videoRef, { likes: admin.firestore.FieldValue.increment(1) });
    return true;
  });
  res.json({ liked: result });
}));

app.delete('/videos/:id', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const ref = db.collection('videos').doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Not found' });
  if (doc.data().uploaderId !== req.user.uid) return res.status(403).json({ error: 'You do not own this video' });
  await deleteCFVideo(req.params.id).catch(() => {});
  await ref.delete();
  await db.collection('users').doc(req.user.uid).set({ videoCount: admin.firestore.FieldValue.increment(-1) }, { merge: true });
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════════
// DOWNLOADS — generate/fetch an MP4 for local saving
// ═══════════════════════════════════════════════════════════════
app.post('/videos/:id/download', writeLimiter, wrap(async (req, res) => {
  const doc = await db.collection('videos').doc(req.params.id).get();
  if (!doc.exists || doc.data().status !== 'live' || doc.data().visibility === 'private') {
    return res.status(404).json({ error: 'Video not found' });
  }
  const uid = doc.data().cloudflareUid || doc.id;
  // Enable downloads (idempotent — CF returns the existing download if already created)
  try {
    await axios.post(`${CF_BASE}/${encodeURIComponent(uid)}/downloads`, {}, { headers: cfHeaders });
  } catch (e) {
    if (e.response?.status !== 409) throw e; // 409 = already enabled
  }
  const dl = await axios.get(`${CF_BASE}/${encodeURIComponent(uid)}/downloads`, { headers: cfHeaders });
  const d = dl.data.result?.default;
  if (!d) return res.status(502).json({ error: 'Download unavailable for this video' });
  res.json({ state: d.status, percent: d.percentComplete || 0, url: d.status === 'ready' ? d.url : null });
}));

// ═══════════════════════════════════════════════════════════════
// VIEWS — 1 device = 1 view, only after 10s of real playback
// (frontend calls this via the Stream player SDK timeupdate event)
// ═══════════════════════════════════════════════════════════════
app.post('/videos/:id/view', writeLimiter, wrap(async (req, res) => {
  const deviceId = String(req.body.deviceId || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (deviceId.length < 16 || deviceId.length > 64) return res.status(400).json({ error: 'Invalid device id' });
  const videoRef = db.collection('videos').doc(req.params.id);
  const videoDoc = await videoRef.get();
  if (!videoDoc.exists || videoDoc.data().status !== 'live') return res.status(404).json({ error: 'Video not found' });
  const viewRef = db.collection('views').doc(`${deviceId}_${req.params.id}`);
  const counted = await db.runTransaction(async tx => {
    const existing = await tx.get(viewRef);
    if (existing.exists) return false;
    tx.set(viewRef, { deviceId, videoId: req.params.id, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(videoRef, { views: admin.firestore.FieldValue.increment(1) });
    return true;
  });
  res.json({ counted });
}));

// ═══════════════════════════════════════════════════════════════
// COMMENTS
// ═══════════════════════════════════════════════════════════════
app.get('/videos/:id/comments', optionalAuth, wrap(async (req, res) => {
  const snap = await db.collection('comments')
    .where('videoId', '==', req.params.id)
    .orderBy('createdAt', 'desc').limit(100).get();
  const comments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  let likedIds = [];
  if (req.user && comments.length) {
    const likeSnaps = await db.getAll(...comments.map(c => db.collection('comment_likes').doc(`${req.user.uid}_${c.id}`)));
    likedIds = likeSnaps.filter(s => s.exists).map(s => s.id.split('_').slice(1).join('_'));
  }
  res.json({ comments: comments.map(c => ({ ...c, liked: likedIds.includes(c.id) })) });
}));

app.post('/videos/:id/comments', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const text = sanitizeText(req.body.text, 2000);
  if (!text) return res.status(400).json({ error: 'Comment cannot be empty' });
  const videoDoc = await db.collection('videos').doc(req.params.id).get();
  if (!videoDoc.exists) return res.status(404).json({ error: 'Video not found' });
  // Threading: optional parentId must be a top-level comment on the same video
  let parentId = null;
  if (req.body.parentId) {
    const parentDoc = await db.collection('comments').doc(String(req.body.parentId)).get();
    if (!parentDoc.exists || parentDoc.data().videoId !== req.params.id) {
      return res.status(400).json({ error: 'Invalid parent comment' });
    }
    parentId = parentDoc.data().parentId || parentDoc.id; // replies-to-replies attach to the root
  }
  const userDoc = await db.collection('users').doc(req.user.uid).get();
  const ref = await db.collection('comments').add({
    videoId: req.params.id,
    userId: req.user.uid,
    displayName: userDoc.data()?.displayName || 'Viewer',
    photoURL: userDoc.data()?.photoURL || null,
    text,
    parentId,
    likes: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await videoDoc.ref.update({ commentCount: admin.firestore.FieldValue.increment(1) });
  if (videoDoc.data().uploaderId !== req.user.uid) {
    notify(videoDoc.data().uploaderId, 'comment',
      `${userDoc.data()?.displayName || 'Someone'} commented on "${videoDoc.data().title || 'your video'}"`, req.params.id);
  }
  res.json({ id: ref.id, parentId });
}));

app.post('/comments/:id/like', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const commentRef = db.collection('comments').doc(req.params.id);
  const commentDoc = await commentRef.get();
  if (!commentDoc.exists) return res.status(404).json({ error: 'Comment not found' });
  const likeRef = db.collection('comment_likes').doc(`${req.user.uid}_${req.params.id}`);
  const liked = await db.runTransaction(async tx => {
    const existing = await tx.get(likeRef);
    if (existing.exists) {
      tx.delete(likeRef);
      tx.update(commentRef, { likes: admin.firestore.FieldValue.increment(-1) });
      return false;
    }
    tx.set(likeRef, { userId: req.user.uid, commentId: req.params.id, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(commentRef, { likes: admin.firestore.FieldValue.increment(1) });
    return true;
  });
  res.json({ liked });
}));

// ═══════════════════════════════════════════════════════════════
// CHANNELS / USERS
// ═══════════════════════════════════════════════════════════════
app.get('/channels/:uid', wrap(async (req, res) => {
  const doc = await db.collection('users').doc(req.params.uid).get();
  if (!doc.exists) return res.status(404).json({ error: 'Channel not found' });
  const { displayName, bio, photoURL, coverURL, username, subscriberCount, videoCount, createdAt } = doc.data();
  res.json({ id: doc.id, displayName, bio, photoURL: photoURL || null, coverURL: coverURL || null, username: username || null, subscriberCount: subscriberCount || 0, videoCount: videoCount || 0, createdAt });
}));

app.get('/channels/:uid/videos', wrap(async (req, res) => {
  const snap = await db.collection('videos')
    .where('uploaderId', '==', req.params.uid)
    .where('status', '==', 'live')
    .where('visibility', '==', 'public')
    .orderBy('createdAt', 'desc').limit(50).get();
  res.json({ videos: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
}));

app.post('/channels/:uid/subscribe', authMiddleware, writeLimiter, wrap(async (req, res) => {
  if (req.params.uid === req.user.uid) return res.status(400).json({ error: 'You cannot subscribe to yourself' });
  const channelRef = db.collection('users').doc(req.params.uid);
  const channelDoc = await channelRef.get();
  if (!channelDoc.exists) return res.status(404).json({ error: 'Channel not found' });
  const subRef = db.collection('subscriptions').doc(`${req.user.uid}_${req.params.uid}`);
  const result = await db.runTransaction(async tx => {
    const existing = await tx.get(subRef);
    if (existing.exists) {
      tx.delete(subRef);
      tx.update(channelRef, { subscriberCount: admin.firestore.FieldValue.increment(-1) });
      return false;
    }
    tx.set(subRef, { subscriberId: req.user.uid, channelId: req.params.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(channelRef, { subscriberCount: admin.firestore.FieldValue.increment(1) });
    return true;
  });
  if (result) {
    const subDoc = await db.collection('users').doc(req.user.uid).get();
    notify(req.params.uid, 'subscriber', `${subDoc.data()?.displayName || 'Someone'} subscribed to your channel 🎉`, req.user.uid);
  }
  res.json({ subscribed: result });
}));

app.get('/me/subscriptions/feed', authMiddleware, wrap(async (req, res) => {
  const subSnap = await db.collection('subscriptions').where('subscriberId', '==', req.user.uid).get();
  const channelIds = subSnap.docs.map(d => d.data().channelId);
  if (!channelIds.length) return res.json({ videos: [] });
  const chunks = [];
  for (let i = 0; i < channelIds.length; i += 30) chunks.push(channelIds.slice(i, i + 30));
  const videos = [];
  for (const chunk of chunks) {
    const snap = await db.collection('videos')
      .where('uploaderId', 'in', chunk)
      .where('status', '==', 'live')
      .where('visibility', '==', 'public')
      .orderBy('createdAt', 'desc').limit(20).get();
    videos.push(...snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }
  videos.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  res.json({ videos: videos.slice(0, 30) });
}));

app.put('/users/profile', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const update = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (req.body.displayName !== undefined) {
    const name = sanitizeText(req.body.displayName, 50);
    if (!name) return res.status(400).json({ error: 'Display name cannot be empty' });
    update.displayName = name;
    update.displayNameLower = name.toLowerCase();
  }
  if (req.body.bio !== undefined) update.bio = sanitizeText(req.body.bio, 1000);
  if (req.body.photoImageId !== undefined) {
    const url = await verifyOwnImage(req.body.photoImageId, req.user.uid);
    if (req.body.photoImageId && !url) return res.status(400).json({ error: 'Invalid profile image' });
    update.photoURL = url;
  }
  if (req.body.coverImageId !== undefined) {
    const url = await verifyOwnImage(req.body.coverImageId, req.user.uid);
    if (req.body.coverImageId && !url) return res.status(400).json({ error: 'Invalid cover image' });
    update.coverURL = url;
  }
  if (req.body.location !== undefined) update.location = sanitizeText(req.body.location, 100);
  if (req.body.mpesaNumber !== undefined) {
    const phone = normalizePhone(req.body.mpesaNumber);
    if (req.body.mpesaNumber && !phone) return res.status(400).json({ error: 'Invalid M-Pesa number. Use format 07XXXXXXXX or 2547XXXXXXXX' });
    update.mpesaNumber = phone || null;
  }
  await db.collection('users').doc(req.user.uid).set(update, { merge: true });
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════════
// PAYMENTS (M-PESA)
// ═══════════════════════════════════════════════════════════════
app.post('/tips/initiate', authMiddleware, requireMpesa, paymentLimiter, wrap(async (req, res) => {
  const { creatorId, videoId } = req.body;
  const phone = normalizePhone(req.body.phone);
  const amount = Number(req.body.amount);
  if (!phone) return res.status(400).json({ error: 'Invalid phone number. Use 07XXXXXXXX or 2547XXXXXXXX' });
  if (!Number.isFinite(amount) || amount < 1 || amount > 150000) return res.status(400).json({ error: 'Amount must be between KSh 1 and KSh 150,000' });
  if (!creatorId) return res.status(400).json({ error: 'Missing creatorId' });
  const creatorDoc = await db.collection('users').doc(creatorId).get();
  if (!creatorDoc.exists) return res.status(404).json({ error: 'Creator not found' });

  const mpesaRes = await stkPush({ phone, amount, reference: 'VTTIP', desc: 'ViewTube Tip' });
  if (mpesaRes.ResponseCode !== '0') return res.status(502).json({ error: mpesaRes.ResponseDescription || 'M-Pesa request failed' });

  await db.collection('tips').doc(mpesaRes.CheckoutRequestID).set({
    type: 'tip',
    fromUserId: req.user.uid,
    toCreatorId: creatorId,
    videoId: videoId || null,
    amount, phone,
    status: 'pending',
    checkoutRequestId: mpesaRes.CheckoutRequestID,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  res.json({ checkoutRequestId: mpesaRes.CheckoutRequestID });
}));

app.post('/memberships/subscribe', authMiddleware, requireMpesa, paymentLimiter, wrap(async (req, res) => {
  const { creatorId, tierId } = req.body;
  const phone = normalizePhone(req.body.phone);
  const amount = Number(req.body.amount);
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  if (!Number.isFinite(amount) || amount < 1 || amount > 150000) return res.status(400).json({ error: 'Invalid amount' });
  if (!creatorId) return res.status(400).json({ error: 'Missing creatorId' });

  const mpesaRes = await stkPush({ phone, amount, reference: 'VTMEM', desc: 'ViewTube Member' });
  if (mpesaRes.ResponseCode !== '0') return res.status(502).json({ error: mpesaRes.ResponseDescription || 'M-Pesa request failed' });

  await db.collection('membership_payments').doc(mpesaRes.CheckoutRequestID).set({
    type: 'membership',
    subscriberId: req.user.uid,
    creatorId, tierId: tierId || null, amount, phone,
    status: 'pending',
    checkoutRequestId: mpesaRes.CheckoutRequestID,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  res.json({ checkoutRequestId: mpesaRes.CheckoutRequestID });
}));

// Frontend polls this to know when the STK push settles
app.get('/payments/:checkoutRequestId/status', authMiddleware, wrap(async (req, res) => {
  const id = req.params.checkoutRequestId;
  const [tip, mem] = await Promise.all([
    db.collection('tips').doc(id).get(),
    db.collection('membership_payments').doc(id).get(),
  ]);
  const doc = tip.exists ? tip : mem.exists ? mem : null;
  if (!doc) return res.status(404).json({ error: 'Payment not found' });
  const data = doc.data();
  const owner = data.fromUserId || data.subscriberId;
  if (owner !== req.user.uid) return res.status(403).json({ error: 'Forbidden' });
  res.json({ status: data.status, receipt: data.mpesaReceipt || null });
}));

// M-Pesa callback (Safaricom calls this — no auth header available)
app.post('/mpesa/callback', wrap(async (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  if (!cb?.CheckoutRequestID) return res.json({ ResultCode: 0, ResultDesc: 'OK' });
  const { CheckoutRequestID, ResultCode } = cb;
  const status = ResultCode === 0 ? 'completed' : 'failed';
  const receipt = ResultCode === 0
    ? cb.CallbackMetadata?.Item?.find(i => i.Name === 'MpesaReceiptNumber')?.Value || null
    : null;

  for (const coll of ['tips', 'membership_payments']) {
    const ref = db.collection(coll).doc(CheckoutRequestID);
    const doc = await ref.get();
    if (!doc.exists) continue;
    if (doc.data().status !== 'pending') break; // idempotent — ignore replays
    await ref.update({ status, mpesaReceipt: receipt, resultCode: ResultCode, settledAt: admin.firestore.FieldValue.serverTimestamp() });
    if (status === 'completed') {
      const data = doc.data();
      const creatorId = data.toCreatorId || data.creatorId;
      const field = coll === 'tips' ? 'tips' : 'memberships';
      await db.collection('earnings').doc(creatorId).set({
        [field]: admin.firestore.FieldValue.increment(data.amount),
        total: admin.firestore.FieldValue.increment(data.amount),
      }, { merge: true });
      notify(creatorId, 'tip', `You received a KSh ${data.amount} ${coll === 'tips' ? 'tip' : 'membership payment'} 🎉`, data.videoId || null);
    }
    break;
  }
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
}));

// ═══════════════════════════════════════════════════════════════
// IMAGES — avatars, covers, thumbnails (compressed client-side,
// stored in Firestore, served with long-lived cache headers)
// ═══════════════════════════════════════════════════════════════
const IMG_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

app.post('/images', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const { data, mime } = req.body;
  if (!IMG_MIMES.includes(mime)) return res.status(400).json({ error: 'Unsupported image type' });
  if (typeof data !== 'string' || data.length < 100) return res.status(400).json({ error: 'Missing image data' });
  if (data.length > 700 * 1024) return res.status(400).json({ error: 'Image too large — must be under ~500KB after compression' });
  if (!/^[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: 'Invalid image encoding' });
  const ref = await db.collection('images').add({
    ownerId: req.user.uid, mime, data,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const base = process.env.API_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ id: ref.id, url: `${base}/img/${ref.id}` });
}));

app.get('/img/:id', wrap(async (req, res) => {
  const doc = await db.collection('images').doc(req.params.id).get();
  if (!doc.exists) return res.status(404).send('Not found');
  const { mime, data } = doc.data();
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(data, 'base64'));
}));

async function verifyOwnImage(imageId, uid) {
  if (!imageId) return null;
  const doc = await db.collection('images').doc(String(imageId)).get();
  if (!doc.exists || doc.data().ownerId !== uid) return null;
  const base = process.env.API_URL || '';
  return `${base}/img/${doc.id}`;
}

// ═══════════════════════════════════════════════════════════════
// ADVERTISING — inbound enquiries from prospective advertisers
// ═══════════════════════════════════════════════════════════════
const AD_BUDGETS = ['under-50k', '50k-200k', '200k-500k', '500k-plus', 'not-sure'];
const AD_GOALS = ['brand-awareness', 'product-launch', 'app-installs', 'event-promo', 'creator-partnership', 'other'];

// Public — no auth, so businesses can enquire without an account
app.post('/advertising/enquiries', rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }), wrap(async (req, res) => {
  const company = sanitizeText(req.body.company, 100);
  const contactName = sanitizeText(req.body.contactName, 80);
  const email = sanitizeText(req.body.email, 120);
  const message = sanitizeText(req.body.message, 2000);
  const phone = req.body.phone ? normalizePhone(req.body.phone) : null;
  const budget = AD_BUDGETS.includes(req.body.budget) ? req.body.budget : 'not-sure';
  const goal = AD_GOALS.includes(req.body.goal) ? req.body.goal : 'other';

  if (!company) return res.status(400).json({ error: 'Company name is required' });
  if (!contactName) return res.status(400).json({ error: 'Your name is required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email address is required' });
  if (!message) return res.status(400).json({ error: 'Please tell us about your campaign' });
  if (req.body.phone && !phone) return res.status(400).json({ error: 'Invalid phone number' });

  const ref = await db.collection('ad_enquiries').add({
    company, contactName, email, phone, budget, goal, message,
    status: 'new',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  // Notify every admin in-app
  if (ADMIN_EMAILS.length) {
    const adminSnap = await db.collection('users').where('email', 'in', ADMIN_EMAILS.slice(0, 10)).get();
    adminSnap.docs.forEach(d => notify(d.id, 'ad_enquiry', `New advertising enquiry from ${company}`, ref.id));
  }
  res.json({ id: ref.id, success: true });
}));

app.get('/advertising/enquiries', authMiddleware, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
  const snap = await db.collection('ad_enquiries').orderBy('createdAt', 'desc').limit(100).get();
  res.json({ enquiries: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
}));

app.post('/advertising/enquiries/:id/status', authMiddleware, wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
  const status = ['new', 'contacted', 'won', 'closed'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'Invalid status' });
  await db.collection('ad_enquiries').doc(req.params.id).update({ status });
  res.json({ success: true });
}));

// Tells the frontend whether to show the admin view
app.get('/me/admin', authMiddleware, wrap(async (req, res) => res.json({ admin: isAdmin(req.user) })));

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════
app.get('/notifications', authMiddleware, wrap(async (req, res) => {
  const [snap, userDoc] = await Promise.all([
    db.collection('notifications').where('userId', '==', req.user.uid).orderBy('createdAt', 'desc').limit(30).get(),
    db.collection('users').doc(req.user.uid).get(),
  ]);
  const readAt = userDoc.data()?.notifReadAt?.seconds || 0;
  const items = snap.docs.map(d => {
    const n = d.data();
    return { id: d.id, ...n, isNew: (n.createdAt?.seconds || 0) > readAt };
  });
  res.json({ notifications: items, unread: items.filter(n => n.isNew).length });
}));

app.get('/messages/unread-count', authMiddleware, wrap(async (req, res) => {
  const snap = await db.collection('conversations').where('participants', 'array-contains', req.user.uid).get();
  const total = snap.docs.reduce((s, d) => s + (d.data().unread?.[req.user.uid] || 0), 0);
  res.json({ unread: total });
}));

app.post('/notifications/read', authMiddleware, wrap(async (req, res) => {
  await db.collection('users').doc(req.user.uid).set({ notifReadAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════════
// MESSAGES — private DMs between users
// ═══════════════════════════════════════════════════════════════
function convoId(a, b) { return [a, b].sort().join('__'); }

app.get('/messages/conversations', authMiddleware, wrap(async (req, res) => {
  const snap = await db.collection('conversations')
    .where('participants', 'array-contains', req.user.uid)
    .orderBy('updatedAt', 'desc').limit(30).get();
  const convos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  // Attach the other participant's display name
  const otherIds = [...new Set(convos.map(c => c.participants.find(p => p !== req.user.uid)).filter(Boolean))];
  const nameMap = {};
  if (otherIds.length) {
    const userSnaps = await db.getAll(...otherIds.map(id => db.collection('users').doc(id)));
    userSnaps.forEach(s => { if (s.exists) nameMap[s.id] = s.data().displayName || 'User'; });
  }
  const visible = convos
    .filter(c => !((c.status === 'declined') && c.requesterId !== req.user.uid)) // hide declined requests from the person who declined
    .map(c => {
      const otherId = c.participants.find(p => p !== req.user.uid);
      return { id: c.id, otherId, otherName: nameMap[otherId] || 'User', lastMessage: c.lastMessage || '', lastSenderId: c.lastSenderId || null, status: c.status || 'accepted', requesterId: c.requesterId || null, unread: c.unread?.[req.user.uid] || 0, updatedAt: c.updatedAt };
    });
  res.json({ conversations: visible, totalUnread: visible.reduce((s, c) => s + c.unread, 0) });
}));

app.get('/messages/:otherUid', authMiddleware, wrap(async (req, res) => {
  const otherUid = req.params.otherUid;
  if (otherUid === req.user.uid) return res.status(400).json({ error: 'Cannot message yourself' });
  const id = convoId(req.user.uid, otherUid);
  const [snap, otherDoc, convoDoc] = await Promise.all([
    db.collection('messages').where('conversationId', '==', id).orderBy('createdAt', 'asc').limit(200).get(),
    db.collection('users').doc(otherUid).get(),
    db.collection('conversations').doc(id).get(),
  ]);
  const convo = convoDoc.exists ? convoDoc.data() : null;
  // Reading the thread marks it read for this user
  if (convo && (convo.unread?.[req.user.uid] || 0) > 0) {
    // update() resolves dotted paths — correct here (unlike set(), see POST /messages)
    db.collection('conversations').doc(id).update({ [`unread.${req.user.uid}`]: 0 }).catch(() => {});
  }
  res.json({
    otherName: otherDoc.exists ? otherDoc.data().displayName || 'User' : 'User',
    status: convo ? (convo.status || 'accepted') : 'new',
    requesterId: convo?.requesterId || null,
    messages: snap.docs.map(d => ({ id: d.id, ...d.data() })),
  });
}));

app.post('/messages/:otherUid', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const otherUid = req.params.otherUid;
  if (otherUid === req.user.uid) return res.status(400).json({ error: 'Cannot message yourself' });
  const text = sanitizeText(req.body.text, 2000);
  let imageUrl = null;
  if (req.body.imageId) {
    imageUrl = await verifyOwnImage(req.body.imageId, req.user.uid);
    if (!imageUrl) return res.status(400).json({ error: 'Invalid image' });
  }
  if (!text && !imageUrl) return res.status(400).json({ error: 'Message cannot be empty' });
  const otherDoc = await db.collection('users').doc(otherUid).get();
  if (!otherDoc.exists) return res.status(404).json({ error: 'User not found' });
  const id = convoId(req.user.uid, otherUid);
  const convoRef = db.collection('conversations').doc(id);
  const convoDoc = await convoRef.get();

  const update = {
    participants: [req.user.uid, otherUid],
    lastMessage: (text || '📷 Photo').slice(0, 120),
    lastSenderId: req.user.uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const senderDoc = await db.collection('users').doc(req.user.uid).get();
  const senderName = senderDoc.data()?.displayName || 'Someone';

  if (!convoDoc.exists) {
    // First message = a message request; the receiver must accept before replying
    update.status = 'pending';
    update.requesterId = req.user.uid;
    update.createdAt = admin.firestore.FieldValue.serverTimestamp();
  } else {
    const c = convoDoc.data();
    const status = c.status || 'accepted'; // conversations from before this feature count as accepted
    const isRequester = c.requesterId === req.user.uid;
    if (status === 'declined' && isRequester) {
      return res.status(403).json({ error: "This user isn't accepting your messages" });
    }
    // Receiver replying to a pending/declined request = implicit accept
    if (status !== 'accepted' && !isRequester) update.status = 'accepted';
    // NOTE: no bell notification for messages — the inbox badge (unread counter
    // below) is the message channel. Keeping both would double-notify.
  }

  // Per-recipient unread counter drives the Messages badge.
  // NOTE: dotted keys ("unread.uid") are literal field names in set() — only update()
  // resolves them as paths. Use a nested object so merge writes into the map correctly.
  update.unread = {
    [otherUid]: admin.firestore.FieldValue.increment(1),
    [req.user.uid]: 0,
  };

  await convoRef.set(update, { merge: true });
  const ref = await db.collection('messages').add({
    conversationId: id,
    senderId: req.user.uid,
    text,
    imageUrl,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  res.json({ id: ref.id });
}));

// Accept or decline a message request (receiver only)
app.post('/messages/:otherUid/respond', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const action = req.body.action;
  if (!['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const id = convoId(req.user.uid, req.params.otherUid);
  const convoRef = db.collection('conversations').doc(id);
  const doc = await convoRef.get();
  if (!doc.exists) return res.status(404).json({ error: 'Conversation not found' });
  const c = doc.data();
  if (!c.participants.includes(req.user.uid)) return res.status(403).json({ error: 'Forbidden' });
  if (c.requesterId === req.user.uid) return res.status(400).json({ error: 'Only the recipient can respond to a request' });
  await convoRef.update({ status: action === 'accept' ? 'accepted' : 'declined' });
  res.json({ status: action === 'accept' ? 'accepted' : 'declined' });
}));

// ═══════════════════════════════════════════════════════════════
// LIVE STREAMING — Cloudflare Stream Live Inputs
// Creator gets an RTMPS URL + key for OBS/streaming apps.
// ═══════════════════════════════════════════════════════════════
const CF_LIVE_BASE = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/stream/live_inputs`;

app.post('/live/start', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const title = sanitizeText(req.body.title, 120) || 'Live Stream';
  // One active stream per creator
  const existing = await db.collection('streams')
    .where('uploaderId', '==', req.user.uid)
    .where('status', 'in', ['created', 'live']).limit(1).get();
  if (!existing.empty) {
    const s = existing.docs[0];
    return res.json({ id: s.id, ...s.data(), resumed: true });
  }
  const cfRes = await axios.post(CF_LIVE_BASE, {
    meta: { name: title, creatorId: req.user.uid },
    recording: { mode: 'automatic', timeoutSeconds: 30 },
  }, { headers: cfHeaders });
  const li = cfRes.data.result;
  // Derive the customer playback subdomain from the webRTC playback URL
  const playbackHost = (li.webRTCPlayback?.url || '').match(/https:\/\/([^/]+)/)?.[1] || null;
  const userDoc = await db.collection('users').doc(req.user.uid).get();
  const doc = {
    uploaderId: req.user.uid,
    channelName: userDoc.data()?.displayName || 'Creator',
    title,
    liveInputUid: li.uid,
    playbackHost,
    rtmpsUrl: li.rtmps?.url || null,
    streamKey: li.rtmps?.streamKey || null,
    webRTCUrl: li.webRTC?.url || null,
    status: 'created',
    viewers: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const ref = await db.collection('streams').add(doc);
  // Credentials are stored on the doc but public endpoints whitelist fields, so only the owner ever receives them
  res.json({ id: ref.id, ...doc });
}));

// Owner polls this; it also flips the public status when OBS connects/disconnects
app.get('/live/:id/status', authMiddleware, wrap(async (req, res) => {
  const ref = db.collection('streams').doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Stream not found' });
  const s = doc.data();
  if (s.uploaderId !== req.user.uid) return res.status(403).json({ error: 'Forbidden' });
  const cfRes = await axios.get(`${CF_LIVE_BASE}/${encodeURIComponent(s.liveInputUid)}`, { headers: cfHeaders });
  const state = cfRes.data.result?.status?.current?.state || 'disconnected';
  if (state === 'connected' && s.status !== 'live') await ref.update({ status: 'live', startedAt: admin.firestore.FieldValue.serverTimestamp() });
  if (state !== 'connected' && s.status === 'live') await ref.update({ status: 'ended', endedAt: admin.firestore.FieldValue.serverTimestamp() });
  res.json({ state, status: state === 'connected' ? 'live' : s.status });
}));

app.get('/live/active', wrap(async (req, res) => {
  const snap = await db.collection('streams')
    .where('status', '==', 'live')
    .orderBy('createdAt', 'desc').limit(20).get();
  res.json({ streams: snap.docs.map(d => {
    const { uploaderId, channelName, title, liveInputUid, playbackHost, createdAt } = d.data();
    return { id: d.id, uploaderId, channelName, title, liveInputUid, playbackHost, createdAt };
  }) });
}));

app.get('/live/:id', wrap(async (req, res) => {
  const doc = await db.collection('streams').doc(req.params.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Stream not found' });
  const { uploaderId, channelName, title, liveInputUid, playbackHost, status, createdAt } = doc.data();
  res.json({ id: doc.id, uploaderId, channelName, title, liveInputUid, playbackHost, status, createdAt });
}));

app.post('/live/:id/stop', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const ref = db.collection('streams').doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Stream not found' });
  if (doc.data().uploaderId !== req.user.uid) return res.status(403).json({ error: 'Forbidden' });
  await axios.delete(`${CF_LIVE_BASE}/${encodeURIComponent(doc.data().liveInputUid)}`, { headers: cfHeaders }).catch(() => {});
  await ref.update({ status: 'ended', endedAt: admin.firestore.FieldValue.serverTimestamp() });
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════════
// STUDIO / ANALYTICS
// ═══════════════════════════════════════════════════════════════
app.get('/studio/analytics', authMiddleware, wrap(async (req, res) => {
  const [videosSnap, userDoc, earningsDoc] = await Promise.all([
    db.collection('videos').where('uploaderId', '==', req.user.uid).orderBy('createdAt', 'desc').limit(100).get(),
    db.collection('users').doc(req.user.uid).get(),
    db.collection('earnings').doc(req.user.uid).get(),
  ]);
  const videos = videosSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({
    totalViews: videos.reduce((s, v) => s + (v.views || 0), 0),
    totalLikes: videos.reduce((s, v) => s + (v.likes || 0), 0),
    subscriberCount: userDoc.data()?.subscriberCount || 0,
    videoCount: videos.length,
    earnings: earningsDoc.data() || { tips: 0, ads: 0, memberships: 0, total: 0 },
    videos,
  });
}));

// ─── Health check ───────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'ViewTube API', mpesa: MPESA_ENABLED ? (process.env.MPESA_ENV === 'production' ? 'live' : 'sandbox') : 'disabled' }));

// ─── 404 + error handler ────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, _next) => {
  if (err.message === 'Not allowed by CORS') return res.status(403).json({ error: 'CORS: origin not allowed' });
  const cfMsg = err.response?.data?.errors?.[0]?.message;
  const mpesaMsg = err.response?.data?.errorMessage;
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} —`, err.response?.data || err.message);
  res.status(500).json({ error: cfMsg || mpesaMsg || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ViewTube API running on port ${PORT} | M-Pesa: ${MPESA_ENABLED ? (process.env.MPESA_ENV === 'production' ? 'LIVE' : 'sandbox') : 'disabled'}`));
