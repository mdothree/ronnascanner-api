/**
 * /api/payment/webhook.js
 * Stripe webhook — updates Firebase Firestore on subscription events
 * Raw body required: set bodyParser: false in vercel.json for this route
 */
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("../lib/firebase");

const db = admin.firestore();
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      // ── Checkout completed ─────────────────────────────────────────────────
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (!userId || userId === "anonymous") break;

        // Get subscription details
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const priceId = subscription.items.data[0]?.price?.id;
        const plan = resolvePlan(priceId);

        await db.collection("subscriptions").doc(userId).set({
          plan,
          status: "active",
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          stripePriceId: priceId,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await logEvent(userId, "subscription_created", { plan });
        break;
      }

      // ── Subscription updated ───────────────────────────────────────────────
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const userId = await getUserIdFromCustomer(sub.customer);
        if (!userId) break;

        const priceId = sub.items.data[0]?.price?.id;
        const plan = resolvePlan(priceId);
        const status = sub.status; // active, past_due, canceled, etc.

        await db.collection("subscriptions").doc(userId).set({
          plan: status === "active" ? plan : "free",
          status,
          stripePriceId: priceId,
          currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await logEvent(userId, "subscription_updated", { plan, status });
        break;
      }

      // ── Subscription deleted / cancelled ──────────────────────────────────
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const userId = await getUserIdFromCustomer(sub.customer);
        if (!userId) break;

        await db.collection("subscriptions").doc(userId).set({
          plan: "free",
          status: "canceled",
          canceledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await logEvent(userId, "subscription_canceled", {});
        break;
      }

      // ── Invoice paid ──────────────────────────────────────────────────────
      case "invoice.paid": {
        const invoice = event.data.object;
        const userId = await getUserIdFromCustomer(invoice.customer);
        if (!userId) break;

        await db.collection("subscriptions").doc(userId).set({
          status: "active",
          lastPaymentDate: new Date(invoice.status_transitions.paid_at * 1000).toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        break;
      }

      // ── Payment failed ─────────────────────────────────────────────────────
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const userId = await getUserIdFromCustomer(invoice.customer);
        if (!userId) break;

        await db.collection("subscriptions").doc(userId).set({
          status: "past_due",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await logEvent(userId, "payment_failed", { invoiceId: invoice.id });
        break;
      }

      default:
        console.log(`Unhandled event: ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function resolvePlan(priceId) {
  const proPriceIds = (process.env.STRIPE_PRO_PRICE_IDS || "").split(",").map(s => s.trim());
  const teamPriceIds = (process.env.STRIPE_TEAM_PRICE_IDS || "").split(",").map(s => s.trim());
  if (teamPriceIds.includes(priceId)) return "team";
  if (proPriceIds.includes(priceId)) return "pro";
  return "pro"; // default to pro for any paid plan
}

async function getUserIdFromCustomer(customerId) {
  const snap = await db.collection("subscriptions")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].id; // doc ID is userId
}

async function logEvent(userId, type, data) {
  await db.collection("payment_events").add({
    userId, type, data,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
}
