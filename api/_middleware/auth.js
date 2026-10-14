/**
 * _middleware/auth.js — Firebase ID token verification (+ optional App Check).
 * Same contract as rigor-api (q7/paid-path).
 *
 * requireAuth(handler):
 *   - 401 unless `Authorization: Bearer <Firebase ID token>` verifies against the
 *     project in FIREBASE_PROJECT_ID (mdo3d-leads, the project all 5 Ronna
 *     front-ends sign in with). verifyIdToken checks signature, expiry, aud and iss.
 *   - 401 for anonymous-auth tokens: anyone holding the public web API key can mint
 *     those, which would give throwaway uids against the paywall.
 *   - App Check: verified when X-Firebase-AppCheck is sent; a missing or invalid
 *     token is a 401 only when APPCHECK_ENFORCE=true.
 *   - req.user is the decoded token. Handlers act ONLY on req.user.uid, never on a
 *     user id from the body or query.
 *   - The handler runs outside the verification try/catch, so its errors are never
 *     reported as "Invalid token".
 */
const admin = require("../lib/firebase");

async function verifyToken(token) {
  return admin.auth().verifyIdToken(token);
}

function isAnonymousToken(decoded) {
  return decoded?.firebase?.sign_in_provider === "anonymous";
}

async function checkAppCheck(req) {
  const enforce = process.env.APPCHECK_ENFORCE === "true";
  const token = req.headers["x-firebase-appcheck"];
  if (!token) return !enforce;
  try {
    req.appCheck = await admin.appCheck().verifyToken(String(token));
    return true;
  } catch {
    return !enforce;
  }
}

function requireAuth(handler) {
  return async (req, res) => {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "unauthorized", message: "Sign in to use Ronna Scanner." });
    }
    let decoded;
    try {
      decoded = await verifyToken(authHeader.slice(7).trim());
    } catch {
      return res.status(401).json({ error: "invalid_token", message: "Your session has expired. Sign in again." });
    }
    if (!decoded || !decoded.uid || isAnonymousToken(decoded)) {
      return res.status(401).json({ error: "unauthorized", message: "Sign in with your Ronna Scanner account." });
    }
    if (!(await checkAppCheck(req))) {
      return res.status(401).json({ error: "app_check_failed", message: "App verification failed. Reload the page and try again." });
    }
    req.user = decoded;
    return handler(req, res);
  };
}

/**
 * 403 when the body (or query) names a different user than the token. The value is
 * never used for anything else; a matching value is simply ignored.
 */
function rejectForeignUserId(req, res) {
  const claimed = [req.body?.userId, req.body?.uid, req.query?.userId, req.query?.uid]
    .find(v => v !== undefined && v !== null && v !== "");
  if (claimed !== undefined && String(claimed) !== req.user.uid) {
    res.status(403).json({ error: "forbidden", message: "You can only act on your own account." });
    return true;
  }
  return false;
}

module.exports = { verifyToken, requireAuth, isAnonymousToken, rejectForeignUserId };
