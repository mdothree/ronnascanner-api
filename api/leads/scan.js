/**
 * ronnascanner-api/api/leads/scan.js
 * Lead scanning via Apollo.io with Firestore caching
 */

const { requireAuth } = require("../_middleware/auth");
const admin = require("../lib/firebase");

module.exports = requireAuth(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { industry, location, size, revenue, tech, limit = 50 } = req.body;
  const userId = req.user.uid;
  const db = admin.firestore();

  // Check subscription for limit enforcement
  const subSnap = await db.doc(`subscriptions/${userId}`).get();
  const plan = subSnap.exists ? subSnap.data().plan : "free";
  const maxResults = plan === "free" ? 25 : plan === "pro" ? 500 : 2000;
  const actualLimit = Math.min(parseInt(limit) || 50, maxResults);

  // Track usage
  const month = new Date().toISOString().slice(0, 7);
  await db.doc(`usage/${userId}_${month}`).set(
    { scans: admin.firestore.FieldValue.increment(1), userId, month },
    { merge: true }
  );

  try {
    // Apollo.io API call
    const apolloRes = await fetch("https://api.apollo.io/v1/mixed_companies/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": process.env.APOLLO_API_KEY
      },
      body: JSON.stringify({
        api_key: process.env.APOLLO_API_KEY,
        q_organization_keyword_tags: industry ? [industry] : undefined,
        organization_locations: location ? [location] : undefined,
        organization_num_employees_ranges: size ? [size] : undefined,
        page: 1,
        per_page: actualLimit
      })
    });

    if (!apolloRes.ok) throw new Error("Apollo API error");
    const apolloData = await apolloRes.json();

    const leads = (apolloData.organizations || []).map(org => ({
      name: org.name,
      industry: org.industry || industry || "Unknown",
      location: org.city && org.state ? `${org.city}, ${org.state}` : location || "Unknown",
      size: org.estimated_num_employees
        ? `${org.estimated_num_employees}` : size || "Unknown",
      revenue: org.annual_revenue_printed || revenue || "Unknown",
      website: org.website_url || "",
      score: Math.min(100, 50 + Math.floor(
        (org.alexa_ranking ? Math.min(50, 50000000 / org.alexa_ranking) : 0)
      ))
    }));

    res.status(200).json({ leads, total: leads.length, plan });
  } catch (err) {
    console.error("Leads scan error:", err);
    res.status(500).json({ error: err.message });
  }
});
