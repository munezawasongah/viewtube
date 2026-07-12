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

async function getUploadUrl(maxDurationSeconds = 21600, creatorId) {
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
    await userRef.set({
      displayName: req.user.name || req.user.email?.split('@')[0] || 'Creator',
      email: req.user.email || null,
      photoURL: req.user.picture || null,
      bio: '',
      subscriberCount: 0,
      videoCount: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  const fresh = await userRef.get();
  res.json({ id: fresh.id, ...fresh.data() });
}));

// ═══════════════════════════════════════════════════════════════
// VIDEOS
// NOTE: static routes (/feed, /trending, /search) MUST be declared
// before /videos/:id or Express matches them as an :id.
// ═══════════════════════════════════════════════════════════════

app.post('/videos/upload-url', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const result = await getUploadUrl(21600, req.user.uid);
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

  await videoRef.update({
    title,
    titleLower: title.toLowerCase(),
    description,
    category,
    tags,
    visibility,
    channelName: userDoc.data()?.displayName || 'Creator',
    thumbnailUrl: cfVideo.thumbnail || null,
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
      await ref.update({ status: 'live', thumbnailUrl: thumbnail || doc.data().thumbnailUrl || null, duration: duration || doc.data().duration || 0 });
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
        const patch = { status: 'live', thumbnailUrl: cf.thumbnail || v.thumbnailUrl || null, duration: cf.duration || v.duration || 0 };
        await doc.ref.update(patch);
        Object.assign(v, patch);
      }
    } catch {}
  }
  doc.ref.update({ views: admin.firestore.FieldValue.increment(1) }).catch(() => {});
  let liked = false, subscribed = false;
  if (req.user) {
    const [likeDoc, subDoc] = await Promise.all([
      db.collection('likes').doc(`${req.user.uid}_${doc.id}`).get(),
      db.collection('subscriptions').doc(`${req.user.uid}_${v.uploaderId}`).get(),
    ]);
    liked = likeDoc.exists; subscribed = subDoc.exists;
  }
  const channelDoc = await db.collection('users').doc(v.uploaderId).get();
  res.json({ id: doc.id, ...v, liked, subscribed, channel: channelDoc.exists ? { id: channelDoc.id, displayName: channelDoc.data().displayName, subscriberCount: channelDoc.data().subscriberCount || 0, photoURL: channelDoc.data().photoURL || null } : null });
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
// COMMENTS
// ═══════════════════════════════════════════════════════════════
app.get('/videos/:id/comments', wrap(async (req, res) => {
  const snap = await db.collection('comments')
    .where('videoId', '==', req.params.id)
    .orderBy('createdAt', 'desc').limit(50).get();
  res.json({ comments: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
}));

app.post('/videos/:id/comments', authMiddleware, writeLimiter, wrap(async (req, res) => {
  const text = sanitizeText(req.body.text, 2000);
  if (!text) return res.status(400).json({ error: 'Comment cannot be empty' });
  const videoDoc = await db.collection('videos').doc(req.params.id).get();
  if (!videoDoc.exists) return res.status(404).json({ error: 'Video not found' });
  const userDoc = await db.collection('users').doc(req.user.uid).get();
  const ref = await db.collection('comments').add({
    videoId: req.params.id,
    userId: req.user.uid,
    displayName: userDoc.data()?.displayName || 'Viewer',
    text,
    likes: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await videoDoc.ref.update({ commentCount: admin.firestore.FieldValue.increment(1) });
  res.json({ id: ref.id });
}));

// ═══════════════════════════════════════════════════════════════
// CHANNELS / USERS
// ═══════════════════════════════════════════════════════════════
app.get('/channels/:uid', wrap(async (req, res) => {
  const doc = await db.collection('users').doc(req.params.uid).get();
  if (!doc.exists) return res.status(404).json({ error: 'Channel not found' });
  const { displayName, bio, photoURL, subscriberCount, videoCount, createdAt } = doc.data();
  res.json({ id: doc.id, displayName, bio, photoURL, subscriberCount: subscriberCount || 0, videoCount: videoCount || 0, createdAt });
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
  }
  if (req.body.bio !== undefined) update.bio = sanitizeText(req.body.bio, 1000);
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
    }
    break;
  }
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
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
