const fs = require('fs');
const path = require('path');

const usedNonces = new Map();
const verifiedPayments = new Map();

function isNonceUsed(nonce) { return usedNonces.has(nonce); }
function markNonceUsed(nonce) { usedNonces.set(nonce, Date.now()); }
function getVerifiedPayment(ref) { return verifiedPayments.get(ref) || null; }
function setVerifiedPayment(ref, data) {
  verifiedPayments.set(ref, { ...data, verifiedAt: Date.now() });
}

/* -------------------------------------------------------------------------
   Bundle purchase counter — persisted to disk so a server RESTART doesn't
   re-open the intro price. On Railway's free tier a full redeploy wipes the
   filesystem, but a restart does not — this covers the restart case.

   BUG FIXED: was path.join(__dirname, '..', 'data') which on a flat
   project structure resolved to /data (outside the project and not
   writable on Railway). Now writes to <project-root>/data/ correctly.
   ------------------------------------------------------------------------- */
const DATA_DIR = path.join(__dirname, '..', 'data'); // lib/ → root → data/
const COUNTER_FILE = path.join(DATA_DIR, 'bundle-purchase-count.json');

let bundleCount = 0;
let countedBundleRefs = new Set();

function loadBundleCounterFromDisk() {
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const raw = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
      bundleCount = typeof raw.count === 'number' ? raw.count : 0;
      countedBundleRefs = new Set(Array.isArray(raw.countedRefs) ? raw.countedRefs : []);
      console.log(`Bundle purchase count loaded from disk: ${bundleCount}`);
    }
  } catch (err) {
    console.warn('Could not read bundle counter from disk — starting at 0:', err.message);
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
    console.warn('Could not persist bundle counter (in-memory count still works):', err.message);
  }
}

function getBundlePurchaseCount() { return bundleCount; }

function incrementBundlePurchaseCountOnce(reference) {
  if (!reference || countedBundleRefs.has(reference)) return false;
  countedBundleRefs.add(reference);
  bundleCount += 1;
  saveBundleCounterToDisk();
  return true;
}

// Hourly cleanup — prevents Maps growing forever on long-running processes
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_MS = 48 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [nonce, ts] of usedNonces) { if (ts < cutoff) usedNonces.delete(nonce); }
  for (const [ref, data] of verifiedPayments) { if (data.verifiedAt < cutoff) verifiedPayments.delete(ref); }
}, CLEANUP_INTERVAL_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = {
  isNonceUsed, markNonceUsed,
  getVerifiedPayment, setVerifiedPayment,
  getBundlePurchaseCount, incrementBundlePurchaseCountOnce
};
