/**
 * ronnascanner-api/api/emails/find.js
 * Email finding via Hunter.io
 */

const { requireAuth } = require("../_middleware/auth");
const admin = require("../lib/firebase");

module.exports = requireAuth(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { firstName, lastName, domain } = req.body;
  if (!firstName || !lastName || !domain) {
    return res.status(400).json({ error: "firstName, lastName, and domain are required" });
  }

  const userId = req.user.uid;
  const db = admin.firestore();

  const month = new Date().toISOString().slice(0, 7);
  await db.doc(`usage/${userId}_${month}`).set(
    { lookups: admin.firestore.FieldValue.increment(1), userId, month },
    { merge: true }
  );

  try {
    const url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${process.env.HUNTER_API_KEY}`;
    const hunterRes = await fetch(url);
    if (!hunterRes.ok) throw new Error("Hunter API error");
    const data = await hunterRes.json();

    res.status(200).json({
      email: data.data?.email || null,
      confidence: data.data?.score || 0,
      verified: (data.data?.score || 0) >= 70,
      sources: data.data?.sources?.slice(0, 3) || []
    });
  } catch (err) {
    console.error("Email find error:", err);
    res.status(500).json({ error: err.message });
  }
});
