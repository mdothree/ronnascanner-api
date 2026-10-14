/**
 * _middleware/limits.js — abuse protection for the AI handlers.
 *
 * withRateLimit(handler, opts)
 *   Best-effort, in-memory, fixed-window limiter. Keyed by the verified Firebase
 *   uid (req.user.uid, set by requireAuth) and falls back to the client IP.
 *   State lives in the function instance's memory, so on Vercel it is per warm
 *   instance (cold starts / parallel instances each get their own counters). It
 *   stops a single client hammering an endpoint; it is NOT a global quota. Put a
 *   shared store (Upstash/Redis, Firestore) behind it if hard limits are needed.
 *
 * withInputCaps(handler, caps)
 *   Server-side length caps that mirror the client limits. Each listed field is
 *   coerced to a string and truncated to its cap (the handlers already used
 *   .slice() this way). Non-string/number values are rejected (400) and grossly
 *   oversized bodies are rejected (413) before any model call is made.
 */

// ─── Rate limit ───────────────────────────────────────────────────────────────
const DEFAULT_WINDOWS = [
  { windowMs: 60 * 1000, max: 15 },       // burst: 15 / minute
  { windowMs: 60 * 60 * 1000, max: 100 }  // sustained: 100 / hour
];

const buckets = new Map(); // key -> { windowStart, count }
let lastSweep = Date.now();

function clientIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.headers?.["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

function sweep(now, maxWindowMs) {
  if (now - lastSweep < 60 * 1000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (now - b.windowStart > maxWindowMs) buckets.delete(k);
  }
}

function withRateLimit(handler, { name = "api", windows = DEFAULT_WINDOWS, now = () => Date.now() } = {}) {
  const maxWindowMs = Math.max(...windows.map(w => w.windowMs));
  return async (req, res) => {
    const t = now();
    sweep(t, maxWindowMs);
    const who = req.user?.uid ? `uid:${req.user.uid}` : `ip:${clientIp(req)}`;

    for (const w of windows) {
      const key = `${name}|${w.windowMs}|${who}`;
      let b = buckets.get(key);
      if (!b || t - b.windowStart >= w.windowMs) {
        b = { windowStart: t, count: 0 };
        buckets.set(key, b);
      }
      if (b.count >= w.max) {
        const retryAfter = Math.max(1, Math.ceil((b.windowStart + w.windowMs - t) / 1000));
        res.setHeader("Retry-After", String(retryAfter));
        return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
      }
    }
    // Only count once every window has room.
    for (const w of windows) buckets.get(`${name}|${w.windowMs}|${who}`).count++;
    return handler(req, res);
  };
}

// ─── Input caps ───────────────────────────────────────────────────────────────
const MAX_BODY_CHARS = 64 * 1024; // largest legit payload (linkedin) is ~15k chars

function withInputCaps(handler, caps) {
  return async (req, res) => {
    if (req.method !== "POST") return handler(req, res); // let the handler 405 it
    const body = req.body;
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Expected a JSON object body" });
    }
    let size;
    try { size = JSON.stringify(body).length; } catch { size = Infinity; }
    if (size > MAX_BODY_CHARS) {
      return res.status(413).json({ error: "Request is too large" });
    }
    for (const [field, max] of Object.entries(caps)) {
      const v = body[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string" && typeof v !== "number") {
        return res.status(400).json({ error: `Invalid value for ${field}` });
      }
      const s = String(v);
      body[field] = s.length > max ? s.slice(0, max) : s;
    }
    return handler(req, res);
  };
}

module.exports = { withRateLimit, withInputCaps, clientIp, _buckets: buckets, MAX_BODY_CHARS };
