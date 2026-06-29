/**
 * In-memory store.
 *
 * Honest tradeoff: this resets if the server restarts or redeploys.
 * That's fine for what it's protecting:
 *   - "used nonces" only need to survive ~24h (a token's own lifetime) —
 *     if the server restarts, already-used tokens become valid again for
 *     a brief window, which is a minor, low-stakes risk for ~$2 PDFs.
 *   - "verified payments" are just a fast cache. If it's empty (cold start,
 *     redeploy), /api/get-download and /api/resend both fall back to asking
 *     Paystack directly via the secret key — so a restart never actually
 *     locks a paying customer out, it just costs one extra API round-trip.
 *
 * If you outgrow this, swap these two Maps for a small SQLite file or a
 * managed Redis — the rest of the app doesn't need to change.
 */

const fs = require('fs');
const path = require('path');

const usedNonces = new Map();        // nonce -> usedAt (ms)
const verifiedPayments = new Map();  // reference -> { plan, amountNaira, verifiedAt }

function isNonceUsed(nonce) {
  return usedNonces.has(nonce);
}

function markNonceUsed(nonce) {
  usedNonces.set(nonce, Date.now());
}

function getVerifiedPayment(reference) {
  return verifiedPayments.get(reference) || null;
}

function setVerifiedPayment(reference, data) {
  verifiedPayments.set(reference, { ...data, verifiedAt: Date.now() });
}

/* =========================================================================
   Full Bundle purchase counter — drives the intro-price cutoff.
   This is the one piece of state in the app where "resets to 0 on restart"
   would actually be a problem (it would re-open the ₦5,000/$3.99 intro
   pricing to everyone after a redeploy), so unlike the Maps above, this is
   persisted to a small JSON file on disk rather than kept purely in memory.

   Honest caveat: on hosting platforms with an ephemeral filesystem (most
   free tiers, on redeploy specifically — not just restart), this file can
   still be wiped. If that ever matters to you, move this counter to a real
   database (even a free one like Railway's Postgres add-on, or Supabase) —
   everything else in the app stays the same, only these few functions
   would need to change.
   ========================================================================= */

const DATA_DIR = path.join(__dirname, '..', 'data');
const COUNTER_FILE = path.join(DATA_DIR, 'bundle-purchase-count.json');

let bundleCount = 0;
let countedBundleRefs = new Set();

function loadBundleCounterFromDisk() {
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const raw = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
      bundleCount = typeof raw.count === 'number' ? raw.count : 0;
      countedBundleRefs = new Set(Array.isArray(raw.countedRefs) ? raw.countedRefs : []);
      console.log(`Loaded bundle purchase count from disk: ${bundleCount}`);
    }
  } catch (err) {
    console.warn('Could not read bundle-purchase-count.json — starting count at 0:', err.message);
  }
}
loadBundleCounterFromDisk();

function saveBundleCounterToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      COUNTER_FILE,
      JSON.stringify({ count: bundleCount, countedRefs: Array.from(countedBundleRefs) })
    );
  } catch (err) {
    console.warn('Could not persist bundle purchase count to disk (still tracked in memory):', err.message);
  }
}

function getBundlePurchaseCount() {
  return bundleCount;
}

/**
 * Increments the counter exactly once per unique payment reference, no
 * matter how many times this gets called for that same reference (webhook
 * retries, the webhook AND the fallback pull-check both seeing the same
 * payment, etc). Returns true if this call was the one that counted it.
 */
function incrementBundlePurchaseCountOnce(reference) {
  if (!reference || countedBundleRefs.has(reference)) return false;
  countedBundleRefs.add(reference);
  bundleCount += 1;
  saveBundleCounterToDisk();
  return true;
}

// Light housekeeping so these Maps don't grow forever on a long-running process.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const RETENTION_MS = 48 * 60 * 60 * 1000;   // keep 48h of history

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [nonce, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(nonce);
  }
  for (const [ref, data] of verifiedPayments) {
    if (data.verifiedAt < cutoff) verifiedPayments.delete(ref);
  }
}, CLEANUP_INTERVAL_MS);

// Don't let this timer keep the process alive on its own during shutdown
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = {
  isNonceUsed,
  markNonceUsed,
  getVerifiedPayment,
  setVerifiedPayment,
  getBundlePurchaseCount,
  incrementBundlePurchaseCountOnce
};
