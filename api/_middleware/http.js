/**
 * _middleware/http.js — the JSON error contract (same shape as the divination APIs'
 * src/httpErrors.js, adapted to plain Vercel functions).
 *
 * withHttp(handler, { methods }) is the OUTERMOST wrapper of every function:
 *   - drops X-Powered-By and sets nosniff / no-store on every response
 *   - 405 + Allow for a method the route does not serve (OPTIONS is always allowed
 *     so CORS preflights reach withCors)
 *   - 400 for a malformed JSON body. @vercel/node parses req.body lazily and throws
 *     a 400 from the getter, so the body is touched here, inside the try.
 *   - 413 for a body over MAX_BODY_BYTES
 *   - any uncaught error -> 500 {error:"internal_error"}; internal messages, stack
 *     traces and upstream errors are never echoed to the client
 *
 * Codes used across the API: 400 bad input · 401 no/invalid token · 402 no paid
 * plan · 403 another user's resource · 404 unknown route · 405 wrong method ·
 * 409 already subscribed · 413 body too large · 429 rate limited · 501 tool not
 * built yet · 502 upstream data provider failed · 503 not configured.
 */
const MAX_BODY_BYTES = 64 * 1024;

function httpError(status, error, message) {
  const e = new Error(message || error);
  e.status = status;
  e.code = error;
  e.expose = true;
  return e;
}

function readBody(req) {
  // Touch the lazy body getter so a parse failure surfaces here.
  const body = req.body;
  if (body === undefined || body === null || body === "") return {};
  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_BODY_BYTES) throw httpError(413, "payload_too_large", "Request body is too large.");
    try { return JSON.parse(body.toString("utf8") || "{}"); } catch { throw httpError(400, "malformed_json", "Malformed JSON in request body."); }
  }
  if (typeof body === "string") {
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw httpError(413, "payload_too_large", "Request body is too large.");
    try { return JSON.parse(body); } catch { throw httpError(400, "malformed_json", "Malformed JSON in request body."); }
  }
  return body;
}

function withHttp(handler, { methods = ["POST"], parseBody = true } = {}) {
  const allow = [...new Set([...methods, "OPTIONS"])];
  return async (req, res) => {
    res.removeHeader?.("X-Powered-By");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!allow.includes(req.method)) {
        res.setHeader("Allow", allow.join(", "));
        return res.status(405).json({ error: "method_not_allowed", message: `Method ${req.method} not allowed.` });
      }
      if (parseBody && req.method === "POST") {
        const len = Number(req.headers["content-length"] || 0);
        if (len > MAX_BODY_BYTES) return res.status(413).json({ error: "payload_too_large", message: "Request body is too large." });
        let body;
        try {
          body = readBody(req);
        } catch (err) {
          if (err && err.expose) throw err;
          // @vercel/node's lazy parser throws { statusCode: 400 } on invalid JSON.
          throw httpError(400, "malformed_json", "Malformed JSON in request body.");
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return res.status(400).json({ error: "bad_request", message: "Expected a JSON object body." });
        }
        Object.defineProperty(req, "body", { value: body, writable: true, configurable: true });
      }
      return await handler(req, res);
    } catch (err) {
      if (res.headersSent || res.writableEnded) return;
      const status = Number(err && (err.status || err.statusCode));
      if (err && err.expose && status >= 400 && status < 500) {
        return res.status(status).json({ error: err.code || "bad_request", message: err.message });
      }
      console.error("server error:", err);
      return res.status(500).json({ error: "internal_error", message: "Something went wrong on our side. No results were generated." });
    }
  };
}

module.exports = { withHttp, httpError, MAX_BODY_BYTES };
