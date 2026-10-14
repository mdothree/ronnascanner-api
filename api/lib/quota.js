/**
 * lib/quota.js — server-side entitlement gate + usage metering (source of truth).
 * Adapted from rigor-api withQuota (q7/paid-path).
 *
 * Paid-only (JARVIS #94): there is no unpaid tier and no unpaid allowance. An
 * account without an active Pro/Team entitlement in subscriptions/{uid} is
 * answered 402 {error:"subscription_required"} BEFORE any data-provider call, so
 * no Apollo/Hunter credit is spent for it. Early access is granted through Stripe
 * promotion codes at checkout (allow_promotion_codes), never here.
 *
 * subscriptions/{uid} is written only by the Stripe webhook (plan pro|team,
 * status active|trialing; unknown prices never grant a plan). Paid calls are
 * counted in usage/{uid}_{YYYY-MM} (server-side; firestore.rules must deny client
 * writes to usage/* and subscriptions/*). A call that ends with an error status is
 * un-counted. If the store is unreachable the gate fails closed (503).
 */
const admin = require("./firebase");

const PAID_PLANS = new Set(["pro", "team"]);
const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const PERIOD_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // tolerate a late renewal webhook

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function isPaidSubscription(s, now = Date.now()) {
  if (!s || !PAID_PLANS.has(s.plan) || !ACTIVE_STATUSES.has(s.status)) return false;
  if (s.currentPeriodEnd) {
    const end = typeof s.currentPeriodEnd.toMillis === "function"
      ? s.currentPeriodEnd.toMillis()
      : Date.parse(s.currentPeriodEnd);
    if (Number.isFinite(end) && end + PERIOD_GRACE_MS < now) return false;
  }
  return true;
}

async function getEntitlement(uid) {
  const snap = await admin.firestore().collection("subscriptions").doc(uid).get();
  const data = snap.exists ? snap.data() : null;
  return { paid: isPaidSubscription(data), plan: isPaidSubscription(data) ? data.plan : null, data };
}

/**
 * withQuota(handler, { counter }) — runs after requireAuth (req.user.uid is verified).
 * Sets req.plan ("pro" | "team") for the handler.
 */
function withQuota(handler, { counter = "calls" } = {}) {
  return async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "unauthorized", message: "Sign in to use Ronna Scanner." });

    let ent;
    try {
      ent = await getEntitlement(uid);
    } catch (err) {
      console.error("entitlement read error:", err);
      return res.status(503).json({ error: "service_unavailable", message: "The subscription service is unavailable. Please try again shortly." });
    }
    if (!ent.paid) {
      return res.status(402).json({
        error: "subscription_required",
        checkout: true,
        message: "Ronna Scanner is a paid tool. A Pro or Team plan is required to run scans. Early-access codes can be applied at checkout."
      });
    }
    req.plan = ent.plan;

    const db = admin.firestore();
    const { FieldValue } = admin.firestore;
    const month = monthKey();
    const ref = db.doc(`usage/${uid}_${month}`);
    const inc = n => ({ [counter]: FieldValue.increment(n), userId: uid, month, updatedAt: FieldValue.serverTimestamp() });
    try {
      await ref.set(inc(1), { merge: true });
    } catch (err) {
      console.error("usage write error:", err);
      return res.status(503).json({ error: "service_unavailable", message: "The usage service is unavailable. Please try again shortly." });
    }

    let statusCode = 200;
    const origStatus = res.status.bind(res);
    res.status = c => { statusCode = c; return origStatus(c); };
    try {
      return await handler(req, res);
    } catch (err) {
      statusCode = 500;
      throw err;
    } finally {
      if (statusCode >= 400) await ref.set(inc(-1), { merge: true }).catch(e => console.error("usage release error:", e));
    }
  };
}

module.exports = { withQuota, isPaidSubscription, getEntitlement, monthKey, PAID_PLANS };
