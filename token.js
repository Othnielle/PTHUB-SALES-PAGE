/**
 * Signed, single-use, expiring download tokens.
 *
 * A token is:   base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
 *
 * The payload itself is never encrypted (no secrets live inside it — just
 * which plan/file it unlocks, an expiry timestamp, and a random nonce), but
 * it IS signed: nobody can change a single byte of it (e.g. swap the fileId
 * to get a different product) without the signature failing verification.
 */

const crypto = require('crypto');

const SECRET = process.env.DOWNLOAD_TOKEN_SECRET;
if (!SECRET) {
  // Fail loudly at startup rather than silently signing tokens with "undefined"
  throw new Error(
    'DOWNLOAD_TOKEN_SECRET is not set. Generate one with `openssl rand -hex 32` ' +
    'and set it as an environment variable before starting the server.'
  );
}

const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payloadObj) {
  const payloadStr = base64url(Buffer.from(JSON.stringify(payloadObj)));
  const sig = crypto.createHmac('sha256', SECRET).update(payloadStr).digest();
  return payloadStr + '.' + base64url(sig);
}

/**
 * Returns the decoded payload if the signature is valid, otherwise null.
 * Does NOT check expiry or single-use — callers check those separately.
 */
function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const dotIndex = token.lastIndexOf('.');
  const payloadStr = token.slice(0, dotIndex);
  const sigStr = token.slice(dotIndex + 1);

  const expectedSig = base64url(crypto.createHmac('sha256', SECRET).update(payloadStr).digest());

  const a = Buffer.from(sigStr);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    return JSON.parse(fromBase64url(payloadStr).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Mint a fresh one-time token for a single file belonging to a plan.
 */
function createDownloadToken({ plan, fileId }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + TOKEN_LIFETIME_MS;
  const token = sign({ plan, fileId, nonce, exp });
  return { token, nonce, exp };
}

module.exports = { sign, verify, createDownloadToken, TOKEN_LIFETIME_MS };
