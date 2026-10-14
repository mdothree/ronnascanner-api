/**
 * POST /api/payment/portal — Stripe billing portal for the CALLER's own account.
 * Auth: verified Firebase ID token. The subscription is read from
 * subscriptions/{req.user.uid}; a body/query userId naming another account is 403
 * (this closes the IDOR the audit found). Return URL: the allowlisted Origin, else
 * https://ronnascanner.com/. Response: { url }.
 */
const admin = require("../lib/firebase");
const { withHttp } = require("../_middleware/http");
const { withCors, ALLOWED_ORIGINS, APEX } = require("../_middleware/cors");
const { requireAuth, rejectForeignUserId } = require("../_middleware/auth");
const { withRateLimit } = require("../_middleware/limits");
const { getStripe } = require("../lib/stripe");

async function handler(req, res) {
  if (rejectForeignUserId(req, res)) return;
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: "not_configured", message: "Billing is not open yet." });

  const snap = await admin.firestore().collection("subscriptions").doc(req.user.uid).get();
  const data = snap.exists ? snap.data() : null;
  if (!data || !data.stripeCustomerId) {
    return res.status(404).json({ error: "not_found", message: "No subscription found for this account." });
  }
  const origin = req.headers.origin;
  const session = await stripe.billingPortal.sessions.create({
    customer: data.stripeCustomerId,
    return_url: (origin && ALLOWED_ORIGINS.has(origin) ? origin : APEX) + "/"
  });
  return res.status(200).json({ url: session.url });
}

module.exports = withHttp(withCors(requireAuth(withRateLimit(handler, {
  name: "portal", windows: [{ windowMs: 60 * 1000, max: 10 }]
}))));
