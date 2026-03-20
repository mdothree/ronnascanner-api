/**
 * /api/payment/portal.js
 * Opens Stripe Customer Portal for subscription management
 */
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("../lib/firebase");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const db = admin.firestore();
    const subSnap = await db.collection("subscriptions").doc(userId).get();
    if (!subSnap.exists) return res.status(404).json({ error: "No subscription found" });

    const { stripeCustomerId } = subSnap.data();
    if (!stripeCustomerId) return res.status(400).json({ error: "No Stripe customer linked" });

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: req.headers.origin + "/"
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("portal error:", err);
    res.status(500).json({ error: err.message });
  }
};
