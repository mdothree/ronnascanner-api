/**
 * POST /api/payment/create-embedded-session — Stripe Embedded Checkout.
 * Auth: verified Firebase ID token; the session is for req.user.uid only (a body
 * userId naming anyone else is 403). CORS: explicit allowlist (no reflected
 * origin). Price and return URL fixed server-side (lib/checkout.js).
 * Body: { priceId: "pro"|"team"|<allowlisted id>, tool? }.
 * Response: { clientSecret, publishableKey? }.
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
    ui_mode: "embedded",
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    return_url: `${host}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    client_reference_id: `ronnascanner:${req.user.uid}`,
    ...(req.user.email ? { customer_email: req.user.email } : {}),
    metadata,
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    subscription_data: { metadata }
  });
  const out = { clientSecret: session.client_secret };
  if (process.env.STRIPE_PUBLISHABLE_KEY) out.publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  return res.status(200).json(out);
}

module.exports = withHttp(withCors(requireAuth(withRateLimit(handler, {
  name: "create-embedded-session", windows: [{ windowMs: 60 * 1000, max: 10 }]
}))));
