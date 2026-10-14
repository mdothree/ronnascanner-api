/**
 * api/meta/index.js — ONE function for the non-data routes (vercel.json passes ?op=):
 *
 *  GET  /health, /api/health   op=health  booleans only: which env groups are set
 *                                         and whether Stripe is in test mode. 200
 *                                         when ready, 503 otherwise. No values.
 *  *    /api/contacts/find      op=stub    501: the tool is not built yet
 *  *    /api/companies/scan     op=stub    501
 *  *    /api/prospects/research op=stub    501
 *  *    anything else           op=notfound 404 JSON (incl. /docs, /openapi*)
 *
 * The 501 stubs are honest placeholders. They take no input, call no provider and
 * return no rows, so the front-ends show "unavailable" instead of fake data.
 */
const { withHttp } = require("../_middleware/http");
const { withCors, applyCors } = require("../_middleware/cors");

const STUBS = {
  "/api/contacts/find": "Contact search",
  "/api/companies/scan": "Company scan",
  "/api/prospects/research": "Prospect research"
};
const STUB_BY_TOOL = { contacts: "Contact search", companies: "Company scan", prospects: "Prospect research" };

const REQUIRED_ENV = {
  firebase: ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"],
  stripe: ["STRIPE_SECRET_KEY"],
  webhook: ["STRIPE_WEBHOOK_SECRET"],
  prices: ["STRIPE_PRO_PRICE_IDS"],
  apollo: ["APOLLO_API_KEY"],
  hunter: ["HUNTER_API_KEY"]
};

function pathOf(req) {
  return String(req.url || "").split("?")[0].replace(/\/+$/, "") || "/";
}

function opOf(req) {
  const q = req.query && req.query.op;
  if (q) return String(q);
  const p = pathOf(req);
  if (p === "/health" || p === "/api/health") return "health";
  if (STUBS[p]) return "stub";
  return "notfound";
}

const health = withHttp(async (req, res) => {
  applyCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const checks = {};
  for (const [k, names] of Object.entries(REQUIRED_ENV)) checks[k] = names.every(n => !!process.env[n]);
  const sk = process.env.STRIPE_SECRET_KEY || "";
  const ok = Object.values(checks).every(Boolean);
  return res.status(ok ? 200 : 503).json({
    ok,
    service: "ronnascanner-api",
    environment: process.env.VERCEL_ENV || "unknown",
    stripeMode: sk ? (/^(sk|rk)_live_/.test(sk) ? "live" : "test") : "unset",
    checks
  });
}, { methods: ["GET", "HEAD"], parseBody: false });

const stub = withHttp(withCors(async (req, res) => {
  const name = STUB_BY_TOOL[req.query && req.query.tool] || STUBS[pathOf(req)] || "This tool";
  return res.status(501).json({
    error: "not_implemented",
    message: `${name} is not available yet. No results were generated.`
  });
}), { methods: ["GET", "POST"], parseBody: false });

const notFound = withHttp(async (req, res) => res.status(404).json({ error: "not_found", message: "Not found." }), {
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], parseBody: false
});

module.exports = async (req, res) => {
  const op = opOf(req);
  if (op === "health") return health(req, res);
  if (op === "stub") return stub(req, res);
  return notFound(req, res);
};
