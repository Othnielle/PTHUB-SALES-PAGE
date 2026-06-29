require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');

const { PRODUCTS, planFromReference, getBundlePricing, validatePaymentAmount } = require('./products');
const { createDownloadToken, verify: verifyToken } = require('./token');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'pthub413@gmail.com';

if (!PAYSTACK_SECRET_KEY) {
  console.warn('⚠️  PAYSTACK_SECRET_KEY is not set — webhook verification and fallback checks will fail.');
}

/* =========================================================================
   1. PAYSTACK WEBHOOK
   Mounted BEFORE express.json() because signature verification needs the
   exact raw request bytes Paystack signed — re-serializing parsed JSON
   would not byte-for-byte match and the signature check would always fail.
   ========================================================================= */
app.post('/webhook/paystack', express.raw({ type: '*/*' }), (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const expected = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY || '')
    .update(req.body)
    .digest('hex');

  if (!signature || !PAYSTACK_SECRET_KEY) {
    console.warn('Webhook rejected: missing signature or secret key not configured');
    return res.sendStatus(401);
  }

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  const validSig = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

  if (!validSig) {
    console.warn('Webhook rejected: signature mismatch');
    return res.sendStatus(401);
  }

  // Acknowledge immediately — Paystack retries aggressively on timeout/non-2xx,
  // and we don't want a slow downstream step to ever cause duplicate retries.
  res.sendStatus(200);

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    console.warn('Webhook: could not parse JSON body');
    return;
  }

  if (event.event !== 'charge.success') return;

  const data = event.data || {};
  const reference = data.reference;
  const amountKobo = data.amount;
  const currency = data.currency;
  const status = data.status;

  if (!reference || status !== 'success') return;

  const plan = planFromReference(reference);
  if (!plan) {
    console.warn('Webhook: reference did not match any known prefix:', reference);
    return;
  }

  if (!validatePaymentAmount(plan, amountKobo, currency)) {
    console.warn('Webhook: amount/currency did not match any valid price for', reference, {
      plan,
      gotAmountMinor: amountKobo,
      gotCurrency: currency
    });
    return;
  }

  store.setVerifiedPayment(reference, { plan, amountMinor: amountKobo, currency });

  if (plan === 'fullbundle') {
    const counted = store.incrementBundlePurchaseCountOnce(reference);
    if (counted) {
      console.log(`📦 Bundle purchase #${store.getBundlePurchaseCount()} counted (${reference})`);
    }
  }

  console.log(`✅ Verified via webhook: ${reference} → ${plan}`);
});

/* =========================================================================
   Everything from here on can use normal JSON body parsing + static files
   ========================================================================= */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================================
   Live Full Bundle pricing — intro price for the first 20 confirmed
   purchases, regular price after. ONLY affects the bundle; every other
   product's price is fixed and lives directly in lib/products.js.
   ========================================================================= */
app.get('/api/bundle-price', (req, res) => {
  const currency = String(req.query.currency || 'NGN').toUpperCase();
  if (currency !== 'NGN' && currency !== 'USD') {
    return res.status(400).json({ error: 'currency must be NGN or USD' });
  }

  const count = store.getBundlePurchaseCount();
  const pricing = getBundlePricing(currency, count);
  if (!pricing) return res.status(400).json({ error: 'No pricing configured for that currency' });

  res.json(pricing);
});

/* =========================================================================
   2. Fallback verification — calls Paystack's own verify-transaction API
   directly with the secret key. Used when:
     - the webhook hasn't arrived yet (front end polls right after checkout
       closes, which can beat the webhook by a second or two), or
     - the in-memory store was wiped by a restart/redeploy, or
     - a buyer comes back later and pastes their reference into "Resend Links"
   ========================================================================= */
async function pullVerifyFromPaystack(reference) {
  if (!PAYSTACK_SECRET_KEY) return null;

  try {
    const resp = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const json = await resp.json();
    if (!json || !json.status || !json.data) return null;

    const data = json.data;
    if (data.status !== 'success') return null;

    const plan = planFromReference(reference);
    if (!plan) return null;

    if (!validatePaymentAmount(plan, data.amount, data.currency)) return null;

    store.setVerifiedPayment(reference, { plan, amountMinor: data.amount, currency: data.currency });

    if (plan === 'fullbundle') {
      const counted = store.incrementBundlePurchaseCountOnce(reference);
      if (counted) {
        console.log(`📦 Bundle purchase #${store.getBundlePurchaseCount()} counted via fallback (${reference})`);
      }
    }

    return { plan, amountMinor: data.amount, currency: data.currency };
  } catch (err) {
    console.error('Pull-verify against Paystack failed:', err.message);
    return null;
  }
}

function mintDownloadsForPlan(plan) {
  const product = PRODUCTS[plan];
  return product.files.map((f) => {
    const { token } = createDownloadToken({ plan, fileId: f.id });
    return { label: f.filename, url: `/download?token=${token}` };
  });
}

/* =========================================================================
   3. Front end polls this immediately after Paystack's client-side
   callback fires, to find out whether it's safe to unlock a download yet.
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
   4. "Resend Links" — same logic, triggered manually with just a reference
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
   5. The ONLY route that can ever produce file bytes.
   Validates: signature → not expired → not already used → file belongs
   to the plan the token was minted for. Only then proxies the bytes from
   Google Drive — the buyer's browser never sees the Drive URL itself.
   ========================================================================= */
app.get('/download', async (req, res) => {
  const token = String(req.query.token || '');
  const payload = verifyToken(token);

  if (!payload) {
    return res.status(400).send(errorPage('This download link is invalid.'));
  }
  if (Date.now() > payload.exp) {
    return res.status(410).send(
      errorPage('This link has expired (links last 24 hours). Go back to the site and use "Resend Links" with your payment reference to get a fresh one.')
    );
  }
  if (store.isNonceUsed(payload.nonce)) {
    return res.status(410).send(
      errorPage('This link has already been used — each one works once. Go back to the site and use "Resend Links" to get a fresh one.')
    );
  }

  const product = PRODUCTS[payload.plan];
  const file = product && product.files.find((f) => f.id === payload.fileId);
  if (!file) {
    return res.status(400).send(errorPage('This download link is invalid.'));
  }

  // Mark used BEFORE streaming, so two near-simultaneous requests with the
  // same link can't both slip through during the fetch.
  store.markNonceUsed(payload.nonce);

  try {
    const driveResp = await fetch(file.driveUrl, { redirect: 'follow' });
    if (!driveResp.ok || !driveResp.body) {
      throw new Error(`Drive responded with ${driveResp.status}`);
    }

    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Type', driveResp.headers.get('content-type') || 'application/pdf');

    Readable.fromWeb(driveResp.body).pipe(res);
  } catch (err) {
    console.error('Download proxy failed:', err.message);
    res.status(502).send(
      errorPage("We couldn't fetch your file just now. Please try this same link again in a minute — it's still valid until it expires or is used.")
    );
  }
});

function errorPage(message) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Download Link — Vibe & Launch</title>
<style>
  body{font-family:'Segoe UI',sans-serif;background:#241F35;color:#F8F1E6;display:flex;
       align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;}
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
  console.log(`Vibe & Launch server running on port ${PORT}`);
});
