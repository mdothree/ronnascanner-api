/**
 * /api/payment/create-embedded-session.js
 * Creates a Stripe Embedded Checkout client_secret
 * Uses stripe.checkout.sessions.create with ui_mode: 'embedded'
 */
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // CORS for embedded element
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { priceId, userId } = req.body;
    if (!priceId) return res.status(400).json({ error: "Missing priceId" });

    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      return_url: `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      metadata: { userId: userId || "anonymous" },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      subscription_data: {
        metadata: { userId: userId || "anonymous" }
      }
    });

    res.status(200).json({ clientSecret: session.client_secret });
  } catch (err) {
    console.error("create-embedded-session error:", err);
    res.status(500).json({ error: err.message });
  }
};
