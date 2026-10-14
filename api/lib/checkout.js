/**
 * lib/checkout.js — shared, fail-closed input handling for both checkout routes.
 *
 *  - Price: only "pro" / "team" (aliases for the first configured id) or an id in
 *    STRIPE_PRO_PRICE_IDS / STRIPE_TEAM_PRICE_IDS. Anything else is 400. Client
 *    amounts / price_data / line_items are refused (400), never forwarded.
 *  - Redirects: success / cancel / return URLs are FIXED by the server on the tool
 *    host (https://<tool>.ronnascanner.com/success.html, /cancel.html). A request
 *    that supplies any URL field is refused (400). The tool host comes from the
 *    allowlisted Origin, or from body.tool (one of the 5 tool names).
 *  - Already subscribed: 409, so nobody pays twice.
 */
const admin = require("./firebase");
const { TOOL_HOSTS, ALLOWED_ORIGINS, APEX } = require("../_middleware/cors");
const { allowedPriceIds, resolvePriceAlias, getStripe } = require("./stripe");
const { isPaidSubscription } = require("./quota");

const URL_FIELDS = ["successUrl", "cancelUrl", "returnUrl", "success_url", "cancel_url", "return_url", "redirectUrl", "url"];
const PRICE_FIELDS = ["price", "amount", "unit_amount", "unitAmount", "price_data", "priceData", "line_items", "lineItems", "currency"];

function toolHost(req) {
  const tool = req.body?.tool;
  if (tool !== undefined) {
    if (typeof tool !== "string" || !Object.prototype.hasOwnProperty.call(TOOL_HOSTS, tool)) return null;
    return TOOL_HOSTS[tool];
  }
  const origin = req.headers?.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  return null;
}

/**
 * Validate a checkout request. Returns { priceId, host, stripe } or writes the
 * error response and returns null.
 */
async function prepareCheckout(req, res) {
  const body = req.body || {};
  if (URL_FIELDS.some(f => body[f] !== undefined)) {
    res.status(400).json({ error: "redirect_not_allowed", message: "Checkout return pages are fixed by the server." });
    return null;
  }
  if (PRICE_FIELDS.some(f => body[f] !== undefined)) {
    res.status(400).json({ error: "price_not_allowed", message: "Prices are set by the server. Send priceId \"pro\" or \"team\"." });
    return null;
  }
  const requested = body.priceId;
  if (!requested || typeof requested !== "string") {
    res.status(400).json({ error: "bad_request", message: "Missing priceId." });
    return null;
  }

  const allowed = allowedPriceIds();
  const stripe = getStripe();
  if (!allowed.length || !stripe) {
    res.status(503).json({ error: "not_configured", message: "Checkout is not open yet. No payment can be taken right now." });
    return null;
  }
  const priceId = resolvePriceAlias(requested);
  if (!priceId || !allowed.includes(priceId)) {
    res.status(400).json({ error: "unknown_price", message: "Unknown priceId." });
    return null;
  }

  const host = toolHost(req);
  if (!host) {
    res.status(400).json({ error: "unknown_origin", message: "Checkout must start from a Ronna Scanner tool page." });
    return null;
  }

  const existing = await admin.firestore().collection("subscriptions").doc(req.user.uid).get();
  if (existing.exists && isPaidSubscription(existing.data())) {
    res.status(409).json({ error: "already_subscribed", message: "This account already has an active plan. Use Manage Plan to change it." });
    return null;
  }

  return { priceId, host, stripe };
}

function sessionMetadata(req) {
  return { userId: req.user.uid, serviceName: "ronnascanner" };
}

module.exports = { prepareCheckout, sessionMetadata, toolHost, URL_FIELDS, PRICE_FIELDS, APEX };
