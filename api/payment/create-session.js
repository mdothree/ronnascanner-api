/**
 * /api/payment/create-session.js
 * Creates a Stripe Checkout session (redirect flow)
 */
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { verifyToken } = require("../_middleware/auth");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { userId, priceId, successUrl, cancelUrl } = req.body;
    if (!userId || !priceId) return res.status(400).json({ error: "Missing userId or priceId" });

    // Verify Firebase token if provided
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      await verifyToken(token); // throws if invalid
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${req.headers.origin}/cancel.html`,
      metadata: { userId },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      customer_creation: "always",
      subscription_data: {
        metadata: { userId }
      }
    });

    res.status(200).json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("create-session error:", err);
    res.status(500).json({ error: err.message });
  }
};
