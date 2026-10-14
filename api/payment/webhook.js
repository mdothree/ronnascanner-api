/**
 * POST /api/payment/webhook — Stripe -> Firestore entitlement sync.
 *
 * Raw body: the signature is computed over the exact bytes Stripe sent, so the
 * body is read from the request stream (rigor-api's method). @vercel/node only
 * parses req.body lazily when it is READ, so this handler must not touch req.body
 * unless it is already a Buffer (and is deliberately NOT wrapped in withHttp, which
 * parses the body). No vercel.json bodyParser setting is needed (that key is
 * invalid in vercel.json and broke the build).
 *
 * 400 for a missing/invalid signature (never 2xx), 500 when applying a verified
 * event fails (Stripe retries), 200 otherwise. A redelivered event is acknowledged
 * without being applied again (lib/stripeEvents.js dedupe). No CORS: Stripe calls
 * this server-to-server.
 */
const { handleStripeEvent } = require("../lib/stripeEvents");
const { getStripe } = require("../lib/stripe");

const MAX_WEBHOOK_BYTES = 512 * 1024;

function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);
  if (typeof req.rawBody === "string") return Promise.resolve(Buffer.from(req.rawBody));
  // @vercel/node (addHelpers -> readBody -> restoreBody) buffers the body and
  // replays the exact bytes into the request stream, so the stream is readable here.
  // If something already drained it, never hang: only an unparsed Buffer/string is
  // usable; a parsed object cannot be verified byte-for-byte (-> 400).
  if (req.readableEnded) {
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    if (typeof req.body === "string") return Promise.resolve(Buffer.from(req.body));
    return Promise.reject(new Error("raw body unavailable"));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += b.length;
      if (size > MAX_WEBHOOK_BYTES) { reject(Object.assign(new Error("too large"), { status: 413 })); return; }
      chunks.push(b);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  res.removeHeader?.("X-Powered-By");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed", message: `Method ${req.method} not allowed.` });
  }
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(503).json({ error: "not_configured", message: "Webhook is not configured." });

  let event;
  try {
    const raw = await readRawBody(req);
    const sig = req.headers["stripe-signature"];
    if (!sig) throw new Error("missing signature");
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    if (err && err.status === 413) return res.status(413).json({ error: "payload_too_large", message: "Request body is too large." });
    console.error("webhook signature error:", err && err.message);
    return res.status(400).json({ error: "invalid_signature", message: "Webhook signature verification failed." });
  }

  try {
    const result = await handleStripeEvent(event);
    return res.status(200).json({ received: true, ...(result.duplicate ? { duplicate: true } : {}) });
  } catch (err) {
    console.error("webhook handler error:", err);
    return res.status(500).json({ error: "webhook_failed", message: "Webhook handling failed." });
  }
};

module.exports.readRawBody = readRawBody;
