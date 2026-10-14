/**
 * POST /api/emails/find — email lookup via Hunter.io (paid plans only).
 *
 * Chain: JSON contract -> CORS allowlist -> verified Firebase token -> rate limit
 * -> paid entitlement (402 otherwise, before any Hunter credit is spent).
 *
 * Modes (the emails front-end sends { mode }):
 *   find   { firstName, lastName, domain } -> { results: [ {email, name, company,
 *          status, confidence, source} ] }  (empty array when Hunter finds nothing)
 *   verify / bulk -> 501: not built yet (Hunter email-verifier). Said plainly
 *          instead of returning an empty or invented result.
 *
 * Honest data: every result field comes from Hunter's response (or is null); the
 * caller's own input is not echoed back as found data. Upstream failure -> 502.
 */
const { withHttp } = require("../_middleware/http");
const { withCors } = require("../_middleware/cors");
const { requireAuth } = require("../_middleware/auth");
const { withRateLimit } = require("../_middleware/limits");
const { withQuota } = require("../lib/quota");

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const NAME_RE = /^[\p{L}\p{M}' .-]{1,60}$/u;

function verificationStatus(d) {
  const s = d?.verification?.status;
  if (s === "valid") return "valid";
  if (s === "accept_all" || s === "unknown") return "risky";
  if (s === "invalid") return "invalid";
  return "unverified";
}

async function handler(req, res) {
  const b = req.body;
  const mode = b.mode === undefined ? "find" : b.mode;
  if (mode === "verify" || mode === "bulk") {
    return res.status(501).json({
      error: "not_implemented",
      message: "Email verification is not available yet. No results were generated."
    });
  }
  if (mode !== "find") return res.status(400).json({ error: "bad_request", message: "mode must be find, verify or bulk." });

  const firstName = typeof b.firstName === "string" ? b.firstName.trim() : "";
  const lastName = typeof b.lastName === "string" ? b.lastName.trim() : "";
  const domain = typeof b.domain === "string" ? b.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "") : "";
  if (!NAME_RE.test(firstName) || !NAME_RE.test(lastName) || !DOMAIN_RE.test(domain)) {
    return res.status(400).json({ error: "bad_request", message: "firstName, lastName and a valid domain are required." });
  }

  if (!process.env.HUNTER_API_KEY) {
    return res.status(503).json({ error: "not_configured", message: "The email data provider is not connected yet. No results were generated." });
  }

  let d;
  try {
    const qs = new URLSearchParams({ domain, first_name: firstName, last_name: lastName, api_key: process.env.HUNTER_API_KEY });
    const r = await fetch(`https://api.hunter.io/v2/email-finder?${qs}`);
    if (r.status === 404) d = null; // Hunter: no email found
    else if (!r.ok) throw new Error(`hunter ${r.status}`);
    else d = (await r.json())?.data || null;
  } catch (err) {
    console.error("emails upstream error:", err && err.message);
    return res.status(502).json({ error: "upstream_unavailable", message: "The email data provider is unavailable. No results were generated." });
  }

  const results = [];
  if (d && d.email) {
    const name = [d.first_name, d.last_name].filter(Boolean).join(" ") || null;
    results.push({
      email: d.email,
      name,
      company: d.company || null,
      status: verificationStatus(d),
      confidence: Number.isFinite(d.score) ? d.score : null,
      source: "hunter"
    });
  }
  return res.status(200).json({ results, total: results.length, source: "hunter" });
}

module.exports = withHttp(withCors(requireAuth(withRateLimit(withQuota(handler, { counter: "lookups" }), {
  name: "emails-find", windows: [{ windowMs: 60 * 1000, max: 20 }, { windowMs: 60 * 60 * 1000, max: 200 }]
}))));
