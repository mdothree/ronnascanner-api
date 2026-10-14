/**
 * POST /api/leads/scan — company leads from Apollo.io (paid plans only).
 *
 * Chain: JSON contract -> CORS allowlist -> verified Firebase token -> rate limit
 * -> paid entitlement (402 otherwise, before any Apollo credit is spent).
 *
 * Request (the leads front-end's field names; older names accepted):
 *   { industry?, location?, companySize? (alias size), keywords?, count? (alias limit) }
 * Response: { leads: [{ company, website, industry, location, size, revenue,
 *   contactName, contactTitle }], total, source: "apollo" }
 *
 * Honest data:
 *  - Every field comes from Apollo or is null. The caller's own filters are NEVER
 *    copied into a lead as if they were data (the old code did that for industry,
 *    location, size and revenue).
 *  - There is no quality score. The old score was 50 + an Alexa-rank bonus; Alexa
 *    is retired, so every lead scored 50. It is dropped rather than invented.
 *  - contactName / contactTitle are null: this route does not search people yet
 *    (that is the /api/contacts/find work, not built).
 *  - Upstream failure -> 502 with no rows; nothing is fabricated.
 */
const { withHttp } = require("../_middleware/http");
const { withCors } = require("../_middleware/cors");
const { requireAuth } = require("../_middleware/auth");
const { withRateLimit } = require("../_middleware/limits");
const { withQuota } = require("../lib/quota");

const MAX_COUNT = 100; // Apollo per_page ceiling
const SIZE_RE = /^\d{1,7},\d{1,7}$/; // Apollo employee range, e.g. "11,50"

function str(v, max = 200) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" && typeof v !== "number") return undefined; // invalid
  const s = String(v).trim().slice(0, max);
  return s || null;
}

function normalizeSize(v) {
  if (!v) return null;
  const s = String(v).replace(/\s+/g, "").replace(/[–—-]/, ",").replace(/\+$/, ",1000000");
  return SIZE_RE.test(s) ? s : undefined;
}

function cleanLocation(org) {
  const parts = [org.city, org.state, org.country].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

async function handler(req, res) {
  const b = req.body;
  const industry = str(b.industry);
  const location = str(b.location);
  const keywordsRaw = str(b.keywords, 300);
  const sizeRaw = str(b.companySize ?? b.size, 40);
  if ([industry, location, keywordsRaw, sizeRaw].includes(undefined)) {
    return res.status(400).json({ error: "bad_request", message: "Filters must be text." });
  }
  const size = normalizeSize(sizeRaw);
  if (size === undefined) {
    return res.status(400).json({ error: "bad_request", message: "companySize must be a range like \"11-50\" or \"1000+\"." });
  }
  const countIn = b.count ?? b.limit ?? 25;
  const count = Math.max(1, Math.min(MAX_COUNT, parseInt(countIn, 10) || 25));
  const keywords = keywordsRaw ? keywordsRaw.split(",").map(s => s.trim()).filter(Boolean).slice(0, 10) : [];
  const tags = [industry, ...keywords].filter(Boolean);

  if (!process.env.APOLLO_API_KEY) {
    return res.status(503).json({ error: "not_configured", message: "The leads data provider is not connected yet. No results were generated." });
  }

  let data;
  try {
    const r = await fetch("https://api.apollo.io/api/v1/mixed_companies/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": process.env.APOLLO_API_KEY },
      body: JSON.stringify({
        ...(tags.length ? { q_organization_keyword_tags: tags } : {}),
        ...(location ? { organization_locations: [location] } : {}),
        ...(size ? { organization_num_employees_ranges: [size] } : {}),
        page: 1,
        per_page: count
      })
    });
    if (!r.ok) throw new Error(`apollo ${r.status}`);
    data = await r.json();
  } catch (err) {
    console.error("leads upstream error:", err && err.message);
    return res.status(502).json({ error: "upstream_unavailable", message: "The leads data provider is unavailable. No results were generated." });
  }

  const orgs = Array.isArray(data?.organizations) ? data.organizations : [];
  const leads = orgs.slice(0, count).map(org => ({
    company: org.name || null,
    website: org.website_url || null,
    industry: org.industry || null,
    location: cleanLocation(org),
    size: Number.isFinite(org.estimated_num_employees) ? String(org.estimated_num_employees) : null,
    revenue: org.annual_revenue_printed || null,
    contactName: null,
    contactTitle: null
  }));
  return res.status(200).json({ leads, total: leads.length, source: "apollo" });
}

module.exports = withHttp(withCors(requireAuth(withRateLimit(withQuota(handler, { counter: "scans" }), {
  name: "leads-scan", windows: [{ windowMs: 60 * 1000, max: 10 }, { windowMs: 60 * 60 * 1000, max: 100 }]
}))));
