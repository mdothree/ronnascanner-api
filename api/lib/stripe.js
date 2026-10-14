/**
 * lib/stripe.js — lazily-created Stripe client + the price allowlist.
 *
 * The client is created on first use so a missing key is a clean 503 from the
 * route instead of a cold-start crash. Deploy with sk_test_ keys first (AUDIT §7).
 * Prices: only ids listed in STRIPE_PRO_PRICE_IDS / STRIPE_TEAM_PRICE_IDS
 * (comma-separated) can be bought or granted. The MDO3 Stripe account sells other
 * products, and their prices must never unlock Ronna Scanner.
 */
let client = null;
let clientKey = null;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!client || clientKey !== key) {
    client = require("stripe")(key);
    clientKey = key;
  }
  return client;
}

function configured(name) {
  return (process.env[name] || "").split(",").map(s => s.trim()).filter(Boolean);
}

function allowedPriceIds() {
  return [...configured("STRIPE_PRO_PRICE_IDS"), ...configured("STRIPE_TEAM_PRICE_IDS")];
}

// "pro" / "team" alias -> the first configured id for that plan (so the static
// front-ends never hard-code a price id); an explicit id is returned unchanged.
function resolvePriceAlias(priceId) {
  if (priceId === "pro") return configured("STRIPE_PRO_PRICE_IDS")[0] || null;
  if (priceId === "team") return configured("STRIPE_TEAM_PRICE_IDS")[0] || null;
  return priceId;
}

function resolvePlan(priceId) {
  if (!priceId) return null;
  if (configured("STRIPE_TEAM_PRICE_IDS").includes(priceId)) return "team";
  if (configured("STRIPE_PRO_PRICE_IDS").includes(priceId)) return "pro";
  return null; // unknown price: grant nothing
}

module.exports = { getStripe, allowedPriceIds, resolvePriceAlias, resolvePlan, configured };
