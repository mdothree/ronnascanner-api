/**
 * ronnascanner-api hardening suite (node:test). Stripe, Firebase, Apollo and
 * Hunter are all stubbed; dummy keys only; any unstubbed network call fails.
 * Covers: CORS, auth, portal IDOR (403), checkout price/URL allowlists, webhook
 * signature (valid/invalid) + dedupe + entitlement write, the 402 paywall, honest
 * data, and the JSON error contract (400/401/402/403/404/405/413/429/501).
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const H = require("./helpers/stubs");
const { state, call, user, paid, reset, streamReq, signer, jsonResponse } = H;

const leads = require("../api/leads/scan");
const emails = require("../api/emails/find");
const portal = require("../api/payment/portal");
const createSession = require("../api/payment/create-session");
const createEmbedded = require("../api/payment/create-embedded-session");
const webhook = require("../api/payment/webhook");
const meta = require("../api/meta/index");

const PRO = "price_test_pro_dummy";
const TEAM = "price_test_team_dummy";
const WHSEC = "whsec_test_dummy";
const ENV = {
  FIREBASE_PROJECT_ID: "mdo3d-leads", FIREBASE_CLIENT_EMAIL: "x", FIREBASE_PRIVATE_KEY: "x",
  STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_PUBLISHABLE_KEY: "pk_test_dummy", STRIPE_WEBHOOK_SECRET: WHSEC,
  STRIPE_PRO_PRICE_IDS: PRO, STRIPE_TEAM_PRICE_IDS: TEAM, APOLLO_API_KEY: "apollo_dummy", HUNTER_API_KEY: "hunter_dummy"
};
const ORIGINS = ["https://ronnascanner.com", "https://leads.ronnascanner.com", "https://emails.ronnascanner.com",
  "https://contacts.ronnascanner.com", "https://companies.ronnascanner.com", "https://prospects.ronnascanner.com"];
const CHECKOUTS = [["create-session", createSession], ["create-embedded-session", createEmbedded]];
const AUTHED = [["leads", leads], ["emails", emails], ["portal", portal], ...CHECKOUTS];

beforeEach(() => { reset(); Object.assign(process.env, ENV); delete process.env.APPCHECK_ENFORCE; });

const apolloOk = (orgs) => (url) => {
  assert.match(url, /^https:\/\/api\.apollo\.io\//);
  return jsonResponse(200, { organizations: orgs });
};

// ─── CORS ─────────────────────────────────────────────────────────────────────
test("CORS: each of the 6 allowlisted origins gets a 204 preflight, its own origin back, Vary: Origin, no credentials", async () => {
  for (const [name, h] of AUTHED) {
    for (const origin of ORIGINS) {
      const r = await call(h, { method: "OPTIONS", origin });
      assert.equal(r.statusCode, 204, `${name} ${origin}`);
      assert.equal(r.headers["access-control-allow-origin"], origin);
      assert.equal(r.headers.vary, "Origin");
      assert.equal(r.headers["access-control-allow-credentials"], undefined);
    }
  }
});

test("CORS: foreign / look-alike origins are never reflected and never get '*'", async () => {
  const bad = ["https://evil.example", "https://leads.ronnascanner.com.evil.example", "http://leads.ronnascanner.com", "null", "https://www.evil-ronnascanner.com"];
  for (const [name, h] of AUTHED) {
    for (const origin of bad) {
      for (const method of ["OPTIONS", "POST"]) {
        const r = await call(h, { method, origin });
        assert.equal(r.headers["access-control-allow-origin"], undefined, `${name} ${method} ${origin}`);
        assert.equal(r.headers.vary, "Origin");
      }
    }
  }
});

test("CORS: preflight is answered before auth (no token needed for OPTIONS)", async () => {
  const r = await call(createEmbedded, { method: "OPTIONS", origin: "https://emails.ronnascanner.com" });
  assert.equal(r.statusCode, 204);
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
test("auth: no bearer, bad token, anonymous token -> 401 on every paid/AI/payment route", async () => {
  state.tokens.set("tok_anon", { uid: "anon1", firebase: { sign_in_provider: "anonymous" } });
  for (const [name, h] of AUTHED) {
    for (const token of [undefined, "not-a-real-token", "tok_anon"]) {
      const r = await call(h, { token, body: { priceId: "pro" } });
      assert.equal(r.statusCode, 401, `${name} token=${token}`);
      assert.equal(typeof r.body.error, "string");
    }
  }
  assert.equal(state.stripeCalls.length, 0);
  assert.equal(state.fetchCalls.length, 0);
});

test("auth: Authorization header without 'Bearer ' prefix is 401", async () => {
  const tok = user("u1");
  const r = await call(leads, { headers: { authorization: tok }, body: {} });
  assert.equal(r.statusCode, 401);
});

// ─── Portal (IDOR) ────────────────────────────────────────────────────────────
test("portal: acts on the token's own uid", async () => {
  const tok = user("alice"); paid("alice");
  const r = await call(portal, { token: tok, body: {} });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.url, "https://billing.stripe.test/cus_alice");
  assert.equal(state.stripeCalls[0].params.return_url, "https://leads.ronnascanner.com/");
});

test("portal: a request naming ANOTHER uid is 403 and never reaches Stripe", async () => {
  const tok = user("mallory"); paid("mallory"); paid("victim");
  for (const body of [{ userId: "victim" }, { uid: "victim" }]) {
    const r = await call(portal, { token: tok, body });
    assert.equal(r.statusCode, 403);
  }
  const rq = await call(portal, { token: tok, body: {}, query: { userId: "victim" } });
  assert.equal(rq.statusCode, 403);
  assert.equal(state.stripeCalls.length, 0);
  assert.ok(!JSON.stringify(state.stripeCalls).includes("cus_victim"));
});

test("portal: own userId in body is fine; no subscription -> 404; foreign origin -> apex return_url", async () => {
  const tok = user("bob");
  let r = await call(portal, { token: tok, body: { userId: "bob" } });
  assert.equal(r.statusCode, 404);
  paid("bob");
  r = await call(portal, { token: tok, body: {}, origin: "https://evil.example" });
  assert.equal(r.statusCode, 200);
  assert.equal(state.stripeCalls[0].params.return_url, "https://ronnascanner.com/");
});

// ─── Checkout ─────────────────────────────────────────────────────────────────
test("checkout: alias 'pro' -> allowlisted price, fixed success/cancel URLs on the tool host, uid from token", async () => {
  const tok = user("carol");
  for (const [name, h] of CHECKOUTS) {
    state.stripeCalls.length = 0;
    const r = await call(h, { token: tok, body: { priceId: "pro" }, origin: "https://companies.ronnascanner.com" });
    assert.equal(r.statusCode, 200, name);
    const p = state.stripeCalls[0].params;
    assert.deepEqual(p.line_items, [{ price: PRO, quantity: 1 }]);
    assert.equal(p.metadata.userId, "carol");
    assert.equal(p.subscription_data.metadata.userId, "carol");
    assert.equal(p.client_reference_id, "ronnascanner:carol");
    assert.equal(p.allow_promotion_codes, true);
    if (name === "create-session") {
      assert.equal(p.success_url, "https://companies.ronnascanner.com/success.html?session_id={CHECKOUT_SESSION_ID}");
      assert.equal(p.cancel_url, "https://companies.ronnascanner.com/cancel.html");
      assert.deepEqual(Object.keys(r.body).sort(), ["sessionId", "url"]);
    } else {
      assert.equal(p.return_url, "https://companies.ronnascanner.com/success.html?session_id={CHECKOUT_SESSION_ID}");
      assert.equal(r.body.clientSecret, "cs_test_stub_secret");
    }
  }
});

test("checkout: explicit allowlisted ids (pro and team) accepted; team alias maps to team id", async () => {
  const tok = user("dan");
  for (const priceId of [PRO, TEAM, "team"]) {
    state.stripeCalls.length = 0;
    const r = await call(createSession, { token: tok, body: { priceId } });
    assert.equal(r.statusCode, 200, priceId);
    assert.ok([PRO, TEAM].includes(state.stripeCalls[0].params.line_items[0].price));
  }
});

test("checkout: client-supplied price ids / amounts are rejected (400) and never reach Stripe", async () => {
  const tok = user("erin");
  const bodies = [
    { priceId: "price_someone_elses_product" }, { priceId: "free" }, { priceId: "" }, {}, { priceId: 999 },
    { priceId: "pro", amount: 1 }, { priceId: "pro", price_data: { unit_amount: 1 } },
    { priceId: "pro", line_items: [{ price: "price_x" }] }, { priceId: "pro", unit_amount: 1 }
  ];
  for (const [name, h] of CHECKOUTS) {
    for (const body of bodies) {
      const r = await call(h, { token: tok, body });
      assert.equal(r.statusCode, 400, `${name} ${JSON.stringify(body)}`);
    }
  }
  assert.equal(state.stripeCalls.length, 0);
});

test("checkout: client-supplied success/cancel/return URLs are rejected (400)", async () => {
  const tok = user("frank");
  const fields = ["successUrl", "cancelUrl", "returnUrl", "success_url", "cancel_url", "return_url", "redirectUrl"];
  for (const [name, h] of CHECKOUTS) {
    for (const f of fields) {
      for (const v of ["https://evil.example/phish", "https://leads.ronnascanner.com/success.html"]) {
        require("../api/_middleware/limits")._buckets.clear(); // stay under the 10/min checkout limit
        const r = await call(h, { token: tok, body: { priceId: "pro", [f]: v } });
        assert.equal(r.statusCode, 400, `${name} ${f}`);
        assert.equal(r.body.error, "redirect_not_allowed");
      }
    }
  }
  assert.equal(state.stripeCalls.length, 0);
});

test("checkout: body userId for another account -> 403; unknown origin w/o tool -> 400; tool param fixes host", async () => {
  const tok = user("gina");
  for (const [name, h] of CHECKOUTS) {
    let r = await call(h, { token: tok, body: { priceId: "pro", userId: "someone_else" } });
    assert.equal(r.statusCode, 403, name);
    r = await call(h, { token: tok, body: { priceId: "pro" }, origin: "https://evil.example" });
    assert.equal(r.statusCode, 400, name);
    r = await call(h, { token: tok, body: { priceId: "pro", tool: "https://evil.example" }, origin: undefined });
    assert.equal(r.statusCode, 400, name);
    state.stripeCalls.length = 0;
    r = await call(h, { token: tok, body: { priceId: "pro", tool: "prospects" }, origin: undefined });
    assert.equal(r.statusCode, 200, name);
    const p = state.stripeCalls[0].params;
    assert.ok((p.success_url || p.return_url).startsWith("https://prospects.ronnascanner.com/success.html"));
  }
});

test("checkout: not configured -> 503; already subscribed -> 409", async () => {
  const tok = user("hank");
  delete process.env.STRIPE_PRO_PRICE_IDS; delete process.env.STRIPE_TEAM_PRICE_IDS;
  let r = await call(createSession, { token: tok, body: { priceId: "pro" } });
  assert.equal(r.statusCode, 503);
  Object.assign(process.env, ENV);
  paid("hank");
  r = await call(createEmbedded, { token: tok, body: { priceId: "pro" } });
  assert.equal(r.statusCode, 409);
  assert.equal(state.stripeCalls.length, 0);
});

// ─── Webhook ──────────────────────────────────────────────────────────────────
function evt(type, object, id = "evt_test_1") {
  return { id, object: "event", type, created: Math.floor(Date.now() / 1000), data: { object } };
}
function signed(ev, secret = WHSEC) {
  const raw = JSON.stringify(ev, null, 2);
  const sig = signer.webhooks.generateTestHeaderString({ payload: raw, secret });
  return { raw, sig };
}
async function deliver(ev, { secret, sig: sigOverride, raw: rawOverride } = {}) {
  const { raw, sig } = signed(ev, secret);
  const headers = sigOverride === null ? {} : { "stripe-signature": sigOverride || sig };
  return call(webhook, { __raw: streamReq(rawOverride || raw, headers) });
}
function completed(uid = "ivy", extra = {}) {
  state.subscriptions.set("sub_1", { id: "sub_1", customer: "cus_ivy", status: "active", current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, items: { data: [{ price: { id: PRO } }] } });
  return evt("checkout.session.completed", {
    object: "checkout.session", id: "cs_test_1", mode: "subscription", payment_status: "paid", subscription: "sub_1",
    customer: "cus_ivy", metadata: { userId: uid, serviceName: "ronnascanner" }, ...extra
  });
}

test("webhook: valid signature over the raw stream -> 200 and subscriptions/{uid} = pro/active", async () => {
  const r = await deliver(completed());
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.received, true);
  const s = state.docs.get("subscriptions/ivy");
  assert.equal(s.plan, "pro"); assert.equal(s.status, "active"); assert.equal(s.stripeCustomerId, "cus_ivy");
  assert.ok(state.docs.has("stripe_events/evt_test_1"));
});

test("webhook: invalid / missing / wrong-secret / tampered signature -> 400 and nothing is written", async () => {
  const ev = completed();
  const cases = [
    await deliver(ev, { sig: "t=1,v1=deadbeef" }),
    await deliver(ev, { sig: null }),
    await deliver(ev, { secret: "whsec_other" }),
    await deliver(ev, { raw: JSON.stringify({ ...ev, id: "evt_forged" }, null, 2) })
  ];
  for (const r of cases) {
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.error, "invalid_signature");
    assert.ok(!JSON.stringify(r.body).includes("whsec"));
  }
  assert.equal(state.docs.size, 0);
});

test("webhook: a drained stream with an already-parsed object body is 400 (cannot verify), never hangs", async () => {
  const { sig } = signed(completed());
  const req = streamReq("", { "stripe-signature": sig });
  for await (const _ of req) { /* drain */ }
  req.body = completed();
  const r = await call(webhook, { __raw: req });
  assert.equal(r.statusCode, 400);
});

test("webhook: redelivered event is deduped (applied once)", async () => {
  const ev = completed();
  await deliver(ev);
  state.docs.set("subscriptions/ivy", { ...state.docs.get("subscriptions/ivy"), plan: "team", marker: 1 });
  const r = await deliver(ev);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.duplicate, true);
  assert.equal(state.docs.get("subscriptions/ivy").marker, 1, "not re-applied");
});

test("webhook: unknown price grants nothing; other service ignored; no user -> nothing", async () => {
  state.subscriptions.set("sub_2", { id: "sub_2", customer: "cus_x", status: "active", current_period_end: 2e9, items: { data: [{ price: { id: "price_other_product" } }] } });
  let r = await deliver(evt("checkout.session.completed", { mode: "subscription", payment_status: "paid", subscription: "sub_2", customer: "cus_x", metadata: { userId: "jay" } }, "evt_a"));
  assert.equal(r.statusCode, 200);
  assert.equal(state.docs.get("subscriptions/jay"), undefined);
  r = await deliver(completed("kim", { metadata: { userId: "kim", serviceName: "rigor" } }));
  assert.equal(state.docs.get("subscriptions/kim"), undefined);
  r = await deliver(completed("", { metadata: {} }));
  assert.equal([...state.docs.keys()].filter(k => k.startsWith("subscriptions/")).length, 0);
});

test("webhook: cancel sets plan 'none' (there is no free plan); a stale event cannot resurrect it", async () => {
  await deliver(completed());
  const now = Math.floor(Date.now() / 1000);
  const del = { ...evt("customer.subscription.deleted", { customer: "cus_ivy" }, "evt_del"), created: now + 10 };
  await deliver(del);
  assert.equal(state.docs.get("subscriptions/ivy").plan, "none");
  assert.equal(state.docs.get("subscriptions/ivy").status, "canceled");
  const late = { ...evt("invoice.paid", { customer: "cus_ivy", status_transitions: { paid_at: now } }, "evt_late"), created: now + 5 };
  await deliver(late);
  assert.equal(state.docs.get("subscriptions/ivy").status, "canceled");
});

test("webhook: GET -> 405; handler failure on a verified event -> 500 (Stripe retries)", async () => {
  let r = await call(webhook, { method: "GET" });
  assert.equal(r.statusCode, 405);
  state.failFirestore = true;
  r = await deliver(completed());
  assert.equal(r.statusCode, 500);
});

// ─── Paywall (402) ────────────────────────────────────────────────────────────
test("paywall: no subscription -> 402 on leads and emails, before any provider call; message has no 'free'", async () => {
  const tok = user("lee");
  for (const [h, body] of [[leads, { industry: "SaaS" }], [emails, { mode: "find", firstName: "A", lastName: "B", domain: "example.com" }]]) {
    const r = await call(h, { token: tok, body });
    assert.equal(r.statusCode, 402);
    assert.equal(r.body.error, "subscription_required");
    assert.ok(!/free/i.test(JSON.stringify(r.body)));
  }
  assert.equal(state.fetchCalls.length, 0);
});

test("paywall: plan 'free', canceled, past_due, expired period, unknown plan -> all 402", async () => {
  const tok = user("max");
  const past = new Date(Date.now() - 30 * 86400e3).toISOString();
  for (const sub of [{ plan: "free", status: "active" }, { plan: "pro", status: "canceled" }, { plan: "pro", status: "past_due" },
    { plan: "pro", status: "active", currentPeriodEnd: past }, { plan: "enterprise", status: "active" }, { plan: "none", status: "canceled" }]) {
    state.docs.set("subscriptions/max", sub);
    const r = await call(leads, { token: tok, body: {} });
    assert.equal(r.statusCode, 402, JSON.stringify(sub));
  }
  assert.equal(state.fetchCalls.length, 0);
});

test("paywall: subscription store down -> 503 (fail closed, no provider call)", async () => {
  const tok = user("ned");
  state.failFirestore = true;
  const r = await call(leads, { token: tok, body: {} });
  assert.equal(r.statusCode, 503);
  assert.equal(state.fetchCalls.length, 0);
});

// ─── Honest data ──────────────────────────────────────────────────────────────
test("leads (paid): front-end field names, company key, no score, nulls instead of echoed filters; key in header only", async () => {
  const tok = user("oli"); paid("oli");
  state.fetchImpl = apolloOk([
    { name: "Acme", website_url: "https://acme.test", industry: "software", city: "Austin", state: "TX", estimated_num_employees: 42, alexa_ranking: 1000 },
    { name: "Bare Co" }
  ]);
  const r = await call(leads, { token: tok, body: { industry: "Fintech", location: "Mars", companySize: "11-50", keywords: "ai, payments", count: 7, revenue: "$1M" } });
  assert.equal(r.statusCode, 200);
  const sent = JSON.parse(state.fetchCalls[0].init.body);
  assert.equal(sent.per_page, 7);
  assert.deepEqual(sent.organization_num_employees_ranges, ["11,50"]);
  assert.deepEqual(sent.q_organization_keyword_tags, ["Fintech", "ai", "payments"]);
  assert.equal(sent.api_key, undefined, "Apollo key is not put in the JSON body");
  assert.equal(state.fetchCalls[0].init.headers["X-Api-Key"], "apollo_dummy");
  const [a, b] = r.body.leads;
  assert.equal(a.company, "Acme"); assert.equal(a.location, "Austin, TX"); assert.equal(a.size, "42");
  assert.equal("score" in a, false, "no invented quality score");
  assert.deepEqual(b, { company: "Bare Co", website: null, industry: null, location: null, size: null, revenue: null, contactName: null, contactTitle: null });
  assert.ok(!JSON.stringify(r.body.leads).includes("Mars") && !JSON.stringify(r.body.leads).includes("Fintech"), "filters not echoed as data");
  assert.equal(state.docs.get(`usage/oli_${new Date().toISOString().slice(0, 7)}`).scans, 1);
});

test("leads (paid): count clamped to 1..100; bad size -> 400; object filter -> 400", async () => {
  const tok = user("pam"); paid("pam");
  state.fetchImpl = apolloOk([]);
  let r = await call(leads, { token: tok, body: { count: 5000 } });
  assert.equal(JSON.parse(state.fetchCalls[0].init.body).per_page, 100);
  r = await call(leads, { token: tok, body: { companySize: "lots" } });
  assert.equal(r.statusCode, 400);
  r = await call(leads, { token: tok, body: { industry: { $gt: "" } } });
  assert.equal(r.statusCode, 400);
});

test("leads (paid): upstream failure -> 502, no rows, usage released", async () => {
  const tok = user("quin"); paid("quin");
  state.fetchImpl = () => jsonResponse(500, {});
  const r = await call(leads, { token: tok, body: {} });
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.leads, undefined);
  assert.equal(state.docs.get(`usage/quin_${new Date().toISOString().slice(0, 7)}`).scans, 0);
});

test("leads (paid): provider key missing -> 503 'not connected', no call", async () => {
  const tok = user("rex"); paid("rex");
  delete process.env.APOLLO_API_KEY;
  const r = await call(leads, { token: tok, body: {} });
  assert.equal(r.statusCode, 503);
  assert.equal(state.fetchCalls.length, 0);
});

test("emails (paid): find -> results[] from Hunter fields; nothing found -> []; verify/bulk -> 501", async () => {
  const tok = user("sam"); paid("sam");
  state.fetchImpl = (url) => {
    assert.match(url, /^https:\/\/api\.hunter\.io\/v2\/email-finder\?/);
    return jsonResponse(200, { data: { email: "jo@acme.test", first_name: "Jo", last_name: "Doe", company: "Acme", score: 91, verification: { status: "valid" } } });
  };
  let r = await call(emails, { token: tok, body: { mode: "find", firstName: "Jo", lastName: "Doe", domain: "https://www.acme.test/about" } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.results, [{ email: "jo@acme.test", name: "Jo Doe", company: "Acme", status: "valid", confidence: 91, source: "hunter" }]);
  assert.match(state.fetchCalls[0].url, /domain=acme\.test/);
  state.fetchImpl = () => jsonResponse(200, { data: { email: null } });
  r = await call(emails, { token: tok, body: { firstName: "Jo", lastName: "Doe", domain: "acme.test" } });
  assert.deepEqual(r.body.results, []);
  for (const mode of ["verify", "bulk"]) {
    r = await call(emails, { token: tok, body: { mode, email: "x@y.z", emails: ["x@y.z"] } });
    assert.equal(r.statusCode, 501);
  }
  r = await call(emails, { token: tok, body: { mode: "find", firstName: "Jo", lastName: "Doe", domain: "not a domain" } });
  assert.equal(r.statusCode, 400);
});

// ─── Error contract ───────────────────────────────────────────────────────────
test("errors: wrong method -> 405 JSON with Allow", async () => {
  const tok = user("tia"); paid("tia");
  for (const [name, h] of AUTHED) {
    const r = await call(h, { token: tok, method: "GET" });
    assert.equal(r.statusCode, 405, name);
    assert.match(r.headers.allow, /POST/);
    assert.equal(r.body.error, "method_not_allowed");
  }
});

test("errors: malformed JSON -> 400, array body -> 400, oversized -> 413 (before auth/provider)", async () => {
  const tok = user("uma"); paid("uma");
  let r = await call(leads, { token: tok, body: "{not json" });
  assert.equal(r.statusCode, 400); assert.equal(r.body.error, "malformed_json");
  r = await call(leads, { token: tok, body: [1, 2] });
  assert.equal(r.statusCode, 400);
  r = await call(leads, { token: tok, body: "x".repeat(70 * 1024) });
  assert.equal(r.statusCode, 413);
  r = await call(leads, { token: tok, body: {}, headers: { "content-length": String(1024 * 1024) } });
  assert.equal(r.statusCode, 413);
  // @vercel/node's lazy body getter throws ApiError(400) on invalid JSON
  const req = H.mockReq({ token: tok });
  Object.defineProperty(req, "body", { get() { throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 }); }, configurable: true });
  const res = H.mockRes(); await leads(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(state.fetchCalls.length, 0);
});

test("errors: rate limit -> 429 with Retry-After", async () => {
  const tok = user("vic"); paid("vic");
  state.fetchImpl = apolloOk([]);
  let last;
  for (let i = 0; i < 12; i++) last = await call(leads, { token: tok, body: {} });
  assert.equal(last.statusCode, 429);
  assert.ok(Number(last.headers["retry-after"]) >= 1);
  assert.equal(state.fetchCalls.length, 10);
  for (let i = 0; i < 11; i++) last = await call(portal, { token: tok, body: {} });
  assert.equal(last.statusCode, 429);
});

test("errors: unexpected exception -> 500 generic JSON, no internals", async () => {
  const tok = user("wes"); paid("wes");
  state.fetchImpl = apolloOk([]);
  const fb = require("../api/lib/firebase");
  const orig = fb.firestore;
  let n = 0;
  fb.firestore = Object.assign(() => { if (++n > 1) throw new Error("SECRET internal detail"); return orig(); }, orig);
  try {
    const r = await call(leads, { token: tok, body: {} });
    assert.ok([500, 503].includes(r.statusCode));
    assert.ok(!JSON.stringify(r.body).includes("SECRET"));
  } finally { fb.firestore = orig; }
});

test("routes: /docs, /openapi.json, unknown -> 404 JSON; the 3 unbuilt tools -> honest 501", async () => {
  for (const url of ["/docs", "/openapi.json", "/api/openapi", "/api/nope", "/"]) {
    const r = await call(meta, { method: "GET", url, query: { op: "notfound" } });
    assert.equal(r.statusCode, 404, url);
    assert.equal(r.body.error, "not_found");
  }
  for (const tool of ["contacts", "companies", "prospects"]) {
    const r = await call(meta, { method: "POST", url: "/x", query: { op: "stub", tool } });
    assert.equal(r.statusCode, 501);
    assert.match(r.body.message, /not available yet\. No results were generated\./);
  }
  const r = await call(meta, { method: "POST", url: "/api/contacts/find", query: {} });
  assert.equal(r.statusCode, 501);
});

test("health: booleans + stripe mode only, never values; 503 when a group is missing", async () => {
  let r = await call(meta, { method: "GET", url: "/health", query: { op: "health" } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.stripeMode, "test");
  const s = JSON.stringify(r.body);
  for (const v of Object.values(ENV)) if (v.length > 3) assert.ok(!s.includes(v) || v === "mdo3d-leads", `leaked ${v}`);
  delete process.env.HUNTER_API_KEY;
  r = await call(meta, { method: "GET", url: "/health", query: { op: "health" } });
  assert.equal(r.statusCode, 503); assert.equal(r.body.checks.hunter, false);
});

test("headers: no X-Powered-By, nosniff + no-store on API responses", async () => {
  const tok = user("xan"); paid("xan");
  state.fetchImpl = apolloOk([]);
  const req = H.mockReq({ token: tok, body: {} });
  const res = H.mockRes(); res.headers["x-powered-by"] = "Express";
  await leads(req, res);
  assert.equal(res.headers["x-powered-by"], undefined);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["cache-control"], "no-store");
});

// ─── Repo hygiene / config ────────────────────────────────────────────────────
test("config: vercel.json has no functions/bodyParser, builds only route dirs, no docs route", () => {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, "../vercel.json"), "utf8"));
  assert.equal(v.functions, undefined);
  assert.ok(!JSON.stringify(v).includes("bodyParser"));
  assert.equal(v.builds.length, 1);
  assert.equal(v.builds[0].src, "api/{payment,leads,emails,meta}/*.js");
  assert.ok(!/docs|openapi|swagger/i.test(JSON.stringify(v.routes)));
  assert.equal(v.routes.at(-1).dest, "/api/meta/index.js?op=notfound");
  for (const r of v.routes) {
    const file = r.dest.split("?")[0].replace(/^\//, "");
    assert.ok(fs.existsSync(path.join(__dirname, "..", file)), file);
  }
});

test("copy: no 'free' plan or wording anywhere in api/ or the README", () => {
  const files = [];
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); f.isDirectory() ? walk(p) : files.push(p); } };
  walk(path.join(__dirname, "../api"));
  files.push(path.join(__dirname, "../README.md"));
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/\bfree\b/i.test(src), `"free" in ${path.relative(path.join(__dirname, ".."), f)}`);
  }
});
