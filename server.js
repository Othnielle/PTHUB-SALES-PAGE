require('dotenv').config();

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const { Readable } = require('stream');

// BUG FIXED: require paths now point to lib/ where the files actually live
const { PRODUCTS, planFromReference, getBundlePricing, validatePaymentAmount } = require('./lib/products');
const { createDownloadToken, verify: verifyToken } = require('./lib/token');
const store = require('./lib/store');

const app  = express();
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'pthub413@gmail.com';

if (!PAYSTACK_SECRET_KEY) {
  console.error('❌ FATAL: PAYSTACK_SECRET_KEY is not set. Webhook verification and payment fallback will both fail. Set this in Railway → Variables.');
}

/* =========================================================================
   1. PAYSTACK WEBHOOK
   Must be before express.json() — we need the raw bytes to verify the sig.
   ========================================================================= */
app.post('/webhook/paystack', express.raw({ type: '*/*' }), (req, res) => {
  const signature = req.headers['x-paystack-signature'];

  if (!signature || !PAYSTACK_SECRET_KEY) {
    console.warn('Webhook rejected: missing signature header or PAYSTACK_SECRET_KEY not set');
    return res.sendStatus(401);
  }

  const expected = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  const validSig = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

  if (!validSig) {
    console.warn('Webhook rejected: HMAC signature mismatch — wrong secret key or tampered body');
    return res.sendStatus(401);
  }

  res.sendStatus(200); // ACK immediately so Paystack stops retrying

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    console.warn('Webhook: JSON parse failed:', e.message);
    return;
  }

  if (event.event !== 'charge.success') return;

  const data      = event.data || {};
  const reference = data.reference;
  const amountKobo = data.amount;
  const currency  = data.currency;
  const status    = data.status;

  if (!reference || status !== 'success') return;

  const plan = planFromReference(reference);
  if (!plan) {
    console.warn('Webhook: reference prefix unrecognised:', reference);
    return;
  }

  if (!validatePaymentAmount(plan, amountKobo, currency)) {
    console.warn('Webhook: amount/currency mismatch for', reference, { plan, amountKobo, currency });
    return;
  }

  store.setVerifiedPayment(reference, { plan, amountMinor: amountKobo, currency });

  if (plan === 'fullbundle') {
    const counted = store.incrementBundlePurchaseCountOnce(reference);
    if (counted) console.log(`📦 Bundle #${store.getBundlePurchaseCount()} counted via webhook (${reference})`);
  }

  console.log(`✅ Webhook verified: ${reference} → ${plan}`);
});

/* =========================================================================
   Standard middleware + static files
   BUG FIXED:
   - Only ONE express.static call, pointing to public/
   - Source files (server.js, products.js, token.js, store.js) are NEVER
     in the public/ folder, so they can't be downloaded by visitors
   ========================================================================= */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================================
   2. Live bundle pricing
   ========================================================================= */
app.get('/api/bundle-price', (req, res) => {
  const currency = String(req.query.currency || 'NGN').toUpperCase();
  if (currency !== 'NGN' && currency !== 'USD') {
    return res.status(400).json({ error: 'currency must be NGN or USD' });
  }
  const pricing = getBundlePricing(currency, store.getBundlePurchaseCount());
  if (!pricing) return res.status(400).json({ error: 'No pricing for that currency' });
  res.json(pricing);
});

/* =========================================================================
   3. Fallback verification — hits Paystack's API directly.
   BUG FIXED: Now logs exactly WHY each check fails, so Railway logs tell
   you precisely what's wrong (wrong key, wrong amount, test vs live, etc.)
   ========================================================================= */
async function pullVerifyFromPaystack(reference) {
  if (!PAYSTACK_SECRET_KEY) {
    console.error('pullVerify: PAYSTACK_SECRET_KEY not set — cannot verify');
    return null;
  }

  let resp, json;
  try {
    resp = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    json = await resp.json();
  } catch (err) {
    console.error('pullVerify: network error calling Paystack API:', err.message);
    return null;
  }

  if (!resp.ok) {
    console.error(`pullVerify: Paystack API returned HTTP ${resp.status}:`, JSON.stringify(json));
    return null;
  }

  if (!json || !json.status || !json.data) {
    console.error('pullVerify: unexpected Paystack response shape:', JSON.stringify(json));
    return null;
  }

  const data = json.data;

  if (data.status !== 'success') {
    console.warn(`pullVerify: transaction status is "${data.status}" (not success) for ${reference}`);
    return null;
  }

  const plan = planFromReference(reference);
  if (!plan) {
    console.error(`pullVerify: reference "${reference}" doesn't match any product prefix`);
    return null;
  }

  if (!validatePaymentAmount(plan, data.amount, data.currency)) {
    console.error(`pullVerify: amount/currency mismatch for ${reference}`, {
      plan,
      received: { amount: data.amount, currency: data.currency },
      expectedNGN: plan !== 'fullbundle' ? PRODUCTS[plan].amountNaira * 100 : 'see bundle pricing',
    });
    return null;
  }

  store.setVerifiedPayment(reference, { plan, amountMinor: data.amount, currency: data.currency });

  if (plan === 'fullbundle') {
    const counted = store.incrementBundlePurchaseCountOnce(reference);
    if (counted) console.log(`📦 Bundle #${store.getBundlePurchaseCount()} counted via fallback (${reference})`);
  }

  console.log(`✅ Fallback verified: ${reference} → ${plan}`);
  return { plan, amountMinor: data.amount, currency: data.currency };
}

function mintDownloadsForPlan(plan) {
  return PRODUCTS[plan].files.map((f) => {
    const { token } = createDownloadToken({ plan, fileId: f.id });
    return { label: f.filename, url: `/download?token=${token}` };
  });
}

/* =========================================================================
   4. Front end polls this after Paystack's client-side callback fires
   ========================================================================= */
app.get('/api/get-download', async (req, res) => {
  const reference = String(req.query.reference || '').trim();
  if (!reference) return res.status(400).json({ ready: false, error: 'Missing reference' });

  let payment = store.getVerifiedPayment(reference);
  if (!payment) payment = await pullVerifyFromPaystack(reference);
  if (!payment || !PRODUCTS[payment.plan]) return res.json({ ready: false });

  res.json({ ready: true, plan: payment.plan, downloads: mintDownloadsForPlan(payment.plan) });
});

/* =========================================================================
   5. Resend Links
   ========================================================================= */
app.post('/api/resend', async (req, res) => {
  const reference = String((req.body && req.body.reference) || '').trim();
  if (!reference) return res.status(400).json({ ready: false, error: 'Missing reference' });

  let payment = store.getVerifiedPayment(reference);
  if (!payment) payment = await pullVerifyFromPaystack(reference);
  if (!payment || !PRODUCTS[payment.plan]) return res.json({ ready: false });

  res.json({ ready: true, plan: payment.plan, downloads: mintDownloadsForPlan(payment.plan) });
});

/* =========================================================================
   6. Secure download proxy — the ONLY route that ever produces file bytes
   ========================================================================= */
app.get('/download', async (req, res) => {
  const token   = String(req.query.token || '');
  const payload = verifyToken(token);

  if (!payload) return res.status(400).send(errorPage('This download link is invalid.'));

  if (Date.now() > payload.exp) {
    return res.status(410).send(errorPage(
      'This link has expired (24 hours). Go back to the site and use "Resend Links" with your payment reference.'
    ));
  }

  if (store.isNonceUsed(payload.nonce)) {
    return res.status(410).send(errorPage(
      'This link has already been used — each one works once. Use "Resend Links" to get a fresh one.'
    ));
  }

  const product = PRODUCTS[payload.plan];
  const file    = product && product.files.find((f) => f.id === payload.fileId);
  if (!file) return res.status(400).send(errorPage('This download link is invalid.'));

  store.markNonceUsed(payload.nonce); // mark BEFORE streaming to block race conditions

  try {
    const driveResp = await fetch(file.driveUrl, { redirect: 'follow' });
    if (!driveResp.ok || !driveResp.body) {
      throw new Error(`Drive responded with HTTP ${driveResp.status}`);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Type', driveResp.headers.get('content-type') || 'application/pdf');
    Readable.fromWeb(driveResp.body).pipe(res);
  } catch (err) {
    console.error('Download proxy error:', err.message);
    res.status(502).send(errorPage(
      "Couldn't fetch your file just now — try this same link again in a minute, it's still valid."
    ));
  }
});

/* =========================================================================
   Health check — lets you confirm the server is alive on Railway
   ========================================================================= */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    paystack_key_set: !!PAYSTACK_SECRET_KEY,
    download_secret_set: !!process.env.DOWNLOAD_TOKEN_SECRET,
    bundle_count: store.getBundlePurchaseCount(),
    uptime_seconds: Math.floor(process.uptime())
  });
});

function errorPage(message) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Download — Vibe & Launch</title>
<style>
  body{font-family:'Segoe UI',sans-serif;background:#241F35;color:#F8F1E6;
       display:flex;align-items:center;justify-content:center;
       min-height:100vh;margin:0;padding:24px;text-align:center;}
  .box{max-width:440px;}
  h2{font-size:20px;line-height:1.4;margin-bottom:14px;}
  a{color:#F0AFC8;font-weight:600;}
  p{color:#C9C2E0;line-height:1.5;}
</style></head>
<body><div class="box">
  <h2>⚠️ ${message}</h2>
  <p>Need help? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
  <p><a href="/">← Back to the site</a></p>
</div></body></html>`;
}

app.listen(PORT, () => {
  console.log(`✅ Vibe & Launch running on port ${PORT}`);
  console.log(`   PAYSTACK_SECRET_KEY: ${PAYSTACK_SECRET_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   DOWNLOAD_TOKEN_SECRET: ${process.env.DOWNLOAD_TOKEN_SECRET ? 'SET ✓' : 'MISSING ✗'}`);
});
