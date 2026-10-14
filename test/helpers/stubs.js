/**
 * test/helpers/stubs.js — in-process fakes so every handler runs under node:test
 * with NO network and NO real credentials:
 *   - firebase-admin / api/lib/firebase.js -> fake auth (token map) + in-memory Firestore
 *   - stripe -> fake client that records checkout / portal calls; webhooks use the
 *     REAL stripe library's signature code (local HMAC only, dummy secret)
 *   - global fetch -> per-test stub (Apollo / Hunter); any unstubbed call throws
 * Require this module BEFORE any api/ module.
 */
const Module = require("module");
const path = require("path");
const { Readable } = require("stream");

const RealStripe = require("stripe");

const state = {
  tokens: new Map(),   // bearer -> decoded token
  docs: new Map(),     // "collection/id" -> data
  stripeCalls: [],     // { kind, params }
  subscriptions: new Map(), // Stripe sub id -> sub object (for subscriptions.retrieve)
  fetchCalls: [],
  fetchImpl: null,
  failFirestore: false
};

// ─── Fake Firestore ───────────────────────────────────────────────────────────
const FieldValue = {
  increment: n => ({ __increment: n }),
  serverTimestamp: () => ({ __serverTimestamp: true })
};

function applySet(key, data, merge) {
  const cur = merge ? { ...(state.docs.get(key) || {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "__increment" in v) cur[k] = Number(cur[k] || 0) + v.__increment;
    else if (v && typeof v === "object" && v.__serverTimestamp) cur[k] = "ts";
    else cur[k] = v;
  }
  state.docs.set(key, cur);
}

function ref(p) {
  return {
    path: p,
    id: p.split("/").pop(),
    get: async () => {
      if (state.failFirestore) throw new Error("firestore down");
      const d = state.docs.get(p);
      return { exists: d !== undefined, id: p.split("/").pop(), data: () => d };
    },
    set: async (data, opts) => {
      if (state.failFirestore) throw new Error("firestore down");
      applySet(p, data, !!(opts && opts.merge));
    }
  };
}

const db = {
  collection: name => ({
    doc: id => ref(`${name}/${id}`),
    where: (field, op, value) => ({
      limit: () => ({
        get: async () => {
          const docs = [...state.docs.entries()]
            .filter(([k, d]) => k.startsWith(`${name}/`) && d && d[field] === value)
            .map(([k, d]) => ({ id: k.slice(name.length + 1), data: () => d }));
          return { empty: docs.length === 0, docs };
        }
      })
    })
  }),
  doc: p => ref(p),
  runTransaction: async fn => fn({ get: r => r.get(), set: (r, data, opts) => applySet(r.path, data, true) })
};

const fakeAdmin = {
  apps: [{}],
  firestore: Object.assign(() => db, { FieldValue }),
  auth: () => ({
    verifyIdToken: async token => {
      if (!state.tokens.has(token)) throw new Error("invalid token");
      return state.tokens.get(token);
    }
  }),
  appCheck: () => ({ verifyToken: async () => ({}) })
};

// ─── Fake Stripe (real webhook signature code) ────────────────────────────────
const signer = new RealStripe("sk_test_dummy_for_signing");

function fakeStripe() {
  return {
    checkout: {
      sessions: {
        create: async params => {
          state.stripeCalls.push({ kind: "checkout", params });
          return { id: "cs_test_stub", url: "https://checkout.stripe.test/stub", client_secret: "cs_test_stub_secret" };
        }
      }
    },
    billingPortal: {
      sessions: {
        create: async params => {
          state.stripeCalls.push({ kind: "portal", params });
          return { url: `https://billing.stripe.test/${params.customer}` };
        }
      }
    },
    subscriptions: {
      retrieve: async id => {
        state.stripeCalls.push({ kind: "sub.retrieve", params: { id } });
        const s = state.subscriptions.get(id);
        if (!s) throw Object.assign(new Error("no such sub"), { statusCode: 404 });
        return s;
      }
    },
    webhooks: signer.webhooks
  };
}

// ─── Install ──────────────────────────────────────────────────────────────────
const firebasePath = path.resolve(__dirname, "../../api/lib/firebase.js");
const m = new Module(firebasePath);
m.filename = firebasePath;
m.loaded = true;
m.exports = fakeAdmin;
require.cache[firebasePath] = m;

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "stripe") return fakeStripe;
  if (request === "firebase-admin") return fakeAdmin;
  return origLoad.call(this, request, parent, isMain);
};

globalThis.fetch = async (url, init) => {
  state.fetchCalls.push({ url: String(url), init });
  if (!state.fetchImpl) throw new Error(`unexpected network call to ${url}`);
  return state.fetchImpl(String(url), init);
};

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// ─── Request / response helpers ───────────────────────────────────────────────
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, ended: false, headersSent: false, writableEnded: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.ended = this.headersSent = this.writableEnded = true; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    removeHeader(k) { delete this.headers[k.toLowerCase()]; },
    end() { this.ended = this.headersSent = this.writableEnded = true; return this; }
  };
}

const DEFAULT_ORIGIN = "https://leads.ronnascanner.com";

function mockReq({ token, body = {}, method = "POST", origin = DEFAULT_ORIGIN, url = "/", query = {}, headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.origin = origin;
  if (token) h.authorization = `Bearer ${token}`;
  return { method, headers: h, body, url, query, socket: { remoteAddress: "127.0.0.1" } };
}

// A stream request carrying exact bytes, like @vercel/node's restored body.
function streamReq(raw, headers = {}) {
  const r = Readable.from([Buffer.from(raw)]);
  r.method = "POST";
  r.url = "/api/payment/webhook";
  r.headers = { "content-type": "application/json", ...headers };
  r.query = {};
  return r;
}

function reset() {
  state.tokens.clear();
  state.docs.clear();
  state.stripeCalls.length = 0;
  state.subscriptions.clear();
  state.fetchCalls.length = 0;
  state.fetchImpl = null;
  state.failFirestore = false;
  try { require("../../api/_middleware/limits")._buckets.clear(); } catch { /* not loaded yet */ }
}

function user(uid, { email = `${uid}@example.test`, provider = "password" } = {}) {
  const tok = `tok_${uid}`;
  state.tokens.set(tok, { uid, email, firebase: { sign_in_provider: provider } });
  return tok;
}

function paid(uid, extra = {}) {
  const end = new Date(Date.now() + 20 * 86400e3).toISOString();
  state.docs.set(`subscriptions/${uid}`, { plan: "pro", status: "active", stripeCustomerId: `cus_${uid}`, currentPeriodEnd: end, ...extra });
}

async function call(handler, opts) {
  const res = mockRes();
  await handler(opts && opts.__raw ? opts.__raw : mockReq(opts), res);
  return res;
}

module.exports = { state, mockReq, mockRes, streamReq, reset, user, paid, call, jsonResponse, signer, DEFAULT_ORIGIN };
