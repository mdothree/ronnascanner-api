/**
 * POST /api/payment/create-session — Stripe Checkout (redirect flow).
 * Auth: verified Firebase ID token; the session is for req.user.uid only (a body
 * userId naming anyone else is 403). Price and return URLs are fixed server-side
 * (lib/checkout.js). Body: { priceId: "pro"|"team"|<allowlisted id>, tool? }.
 * Response: { sessionId, url }.
 */
const { withHttp } = require("../_middleware/http");
const { withCors } = require("../_middleware/cors");
const { requireAuth, rejectForeignUserId } = require("../_middleware/auth");
const { withRateLimit } = require("../_middleware/limits");
const { prepareCheckout, sessionMetadata } = require("../lib/checkout");

async function handler(req, res) {
  if (rejectForeignUserId(req, res)) return;
  const prep = await prepareCheckout(req, res);
  if (!prep) return;
  const { priceId, host, stripe } = prep;
  const metadata = sessionMetadata(req);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${host}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${host}/cancel.html`,
    client_reference_id: `ronnascanner:${req.user.uid}`,
    ...(req.user.email ? { customer_email: req.user.email } : {}),
    metadata,
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    subscription_data: { metadata }
  });
  return res.status(200).json({ sessionId: session.id, url: session.url });
}

module.exports = withHttp(withCors(requireAuth(withRateLimit(handler, {
  name: "create-session", windows: [{ windowMs: 60 * 1000, max: 10 }]
}))));
