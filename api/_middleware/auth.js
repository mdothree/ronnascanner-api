/**
 * _middleware/auth.js — Firebase token verification
 */
const admin = require("../lib/firebase");

async function verifyToken(token) {
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded;
}

function requireAuth(handler) {
  return async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const token = authHeader.replace("Bearer ", "");
      req.user = await verifyToken(token);
      return handler(req, res);
    } catch (err) {
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}

module.exports = { verifyToken, requireAuth };
