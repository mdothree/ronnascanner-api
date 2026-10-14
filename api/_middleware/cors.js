/**
 * _middleware/cors.js — CORS for the ronnascanner.com front-ends.
 *
 * The planned hosting (AUDIT §4) proxies each tool's same-origin /api/* to this
 * project with a Vercel rewrite, so most calls are not cross-origin at all. When a
 * tool page does call the API host directly, the preflight OPTIONS is answered
 * here, BEFORE requireAuth (which would otherwise 401 the preflight without CORS
 * headers and the browser would block the call).
 *
 * Explicit allowlist only: no wildcard, no reflected origin, no credentials
 * (auth is a Bearer header, not a cookie, so Allow-Credentials is never sent).
 * Vary: Origin is always set so a CDN never serves one origin's answer to another.
 */
const TOOL_HOSTS = {
  leads: "https://leads.ronnascanner.com",
  emails: "https://emails.ronnascanner.com",
  contacts: "https://contacts.ronnascanner.com",
  companies: "https://companies.ronnascanner.com",
  prospects: "https://prospects.ronnascanner.com"
};

const APEX = "https://ronnascanner.com";

const ALLOWED_ORIGINS = new Set([APEX, ...Object.values(TOOL_HOSTS)]);

function applyCors(req, res, methods = "POST, OPTIONS") {
  const origin = req.headers && req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", methods);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Firebase-AppCheck");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  res.setHeader("Vary", "Origin");
}

function withCors(handler, { methods = "POST, OPTIONS" } = {}) {
  return async (req, res) => {
    applyCors(req, res, methods);
    if (req.method === "OPTIONS") return res.status(204).end();
    return handler(req, res);
  };
}

module.exports = { withCors, applyCors, ALLOWED_ORIGINS, TOOL_HOSTS, APEX };
