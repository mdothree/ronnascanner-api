/**
 * lib/stripeEvents.js — verified Stripe event -> Firestore entitlement.
 * Adapted from rigor-api lib/stripeEvents.js (q7/paid-path).
 *
 * Writes subscriptions/{uid}: { plan: "pro"|"team"|"none", status, stripeCustomerId,
 * stripeSubscriptionId, stripePriceId, currentPeriodEnd, ... }. There is no "free"
 * plan: an account without a paid entitlement has plan "none".
 *
 * Who: checkout.session.completed is granted to metadata.userId, which
 * create-session / create-embedded-session set from the VERIFIED ID token (never
 * the body). Later events find the uid by stripeCustomerId.
 * Dedupe: stripe_events/{event.id} marks a processed event; a redelivery is
 * acknowledged without being applied again.
 * Ordering: Stripe does not guarantee order, so writeSub() skips an event older
 * than the last applied one (a late invoice.paid cannot resurrect a canceled plan).
 * Scope: events whose object names another serviceName are ignored; unknown
 * prices never grant anything.
 */
const admin = require("./firebase");
const { getStripe, resolvePlan } = require("./stripe");

const SERVICE_NAME = "ronnascanner";
const UID_RE = /^[A-Za-z0-9]{1,128}$/;

function db() { return admin.firestore(); }

function serviceNameOf(obj) {
  return obj?.metadata?.serviceName
    || obj?.subscription_details?.metadata?.serviceName
    || obj?.parent?.subscription_details?.metadata?.serviceName
    || null;
}

async function alreadyProcessed(eventId) {
  if (!eventId) return false;
  const snap = await db().collection("stripe_events").doc(eventId).get();
  return snap.exists;
}

async function markProcessed(event, userId, outcome) {
  if (!event?.id) return;
  await db().collection("stripe_events").doc(event.id).set({
    type: event.type, userId: userId || null, outcome,
    processedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function writeSub(userId, event, data) {
  const ref = db().collection("subscriptions").doc(userId);
  const created = Number(event?.created) || 0;
  await db().runTransaction(async t => {
    const snap = await t.get(ref);
    const last = snap.exists ? Number(snap.data().lastEventCreated) || 0 : 0;
    if (created && last && created < last) return; // stale event
    t.set(ref, {
      ...data,
      lastEventCreated: Math.max(created, last),
      lastEventId: event?.id || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

async function getUserIdFromCustomer(customerId) {
  if (!customerId) return null;
  const snap = await db().collection("subscriptions").where("stripeCustomerId", "==", customerId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

function isoFromUnix(s) {
  return Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null;
}

/**
 * Apply one verified event. Returns { duplicate?, ignored?, outcome, userId }.
 */
async function handleStripeEvent(event) {
  if (await alreadyProcessed(event.id)) return { duplicate: true };

  const obj = event?.data?.object || {};
  const svc = serviceNameOf(obj);
  if (svc && svc !== SERVICE_NAME) {
    await markProcessed(event, null, "other_service");
    return { ignored: true, outcome: "other_service" };
  }

  let userId = null;
  let outcome = "unhandled";

  switch (event.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription" || !obj.subscription) { outcome = "not_subscription"; break; }
      if (!["paid", "no_payment_required"].includes(obj.payment_status)) { outcome = "not_paid"; break; }
      const meta = obj.metadata?.userId;
      if (!meta || !UID_RE.test(meta)) { outcome = "no_user"; break; }
      const stripe = getStripe();
      if (!stripe) throw new Error("STRIPE_SECRET_KEY is not set");
      const sub = await stripe.subscriptions.retrieve(obj.subscription);
      const priceId = sub?.items?.data?.[0]?.price?.id || null;
      const plan = resolvePlan(priceId);
      if (!plan) { outcome = "unknown_price"; break; }
      userId = meta;
      await writeSub(userId, event, {
        plan,
        status: sub.status || "active",
        stripeCustomerId: obj.customer || sub.customer || null,
        stripeSubscriptionId: sub.id || obj.subscription,
        stripePriceId: priceId,
        currentPeriodEnd: isoFromUnix(sub.current_period_end),
        checkoutSessionId: obj.id || null
      });
      outcome = "granted";
      break;
    }

    case "customer.subscription.updated": {
      userId = await getUserIdFromCustomer(obj.customer);
      if (!userId) { outcome = "no_user"; break; }
      const priceId = obj.items?.data?.[0]?.price?.id || null;
      const plan = resolvePlan(priceId);
      const paidNow = ["active", "trialing"].includes(obj.status) && plan;
      await writeSub(userId, event, {
        plan: paidNow ? plan : "none",
        status: obj.status,
        stripePriceId: priceId,
        currentPeriodEnd: isoFromUnix(obj.current_period_end),
        cancelAtPeriodEnd: !!obj.cancel_at_period_end
      });
      outcome = "updated";
      break;
    }

    case "customer.subscription.deleted": {
      userId = await getUserIdFromCustomer(obj.customer);
      if (!userId) { outcome = "no_user"; break; }
      await writeSub(userId, event, { plan: "none", status: "canceled", canceledAt: admin.firestore.FieldValue.serverTimestamp() });
      outcome = "canceled";
      break;
    }

    case "invoice.paid": {
      userId = await getUserIdFromCustomer(obj.customer);
      if (!userId) { outcome = "no_user"; break; }
      await writeSub(userId, event, { status: "active", lastPaymentDate: isoFromUnix(obj.status_transitions?.paid_at) });
      outcome = "invoice_paid";
      break;
    }

    case "invoice.payment_failed": {
      userId = await getUserIdFromCustomer(obj.customer);
      if (!userId) { outcome = "no_user"; break; }
      await writeSub(userId, event, { status: "past_due" });
      outcome = "payment_failed";
      break;
    }

    default:
      outcome = "unhandled";
  }

  await markProcessed(event, userId, outcome);
  return { outcome, userId };
}

module.exports = { handleStripeEvent, writeSub, SERVICE_NAME };
