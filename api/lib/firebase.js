/**
 * lib/firebase.js — Firebase Admin SDK (singleton, project mdo3d-leads).
 *
 * Initialized once per function instance from the service-account env vars
 * (Vercel project env, never committed):
 *   FIREBASE_PROJECT_ID    mdo3d-leads
 *   FIREBASE_CLIENT_EMAIL  firebase-adminsdk-xxxxx@mdo3d-leads.iam.gserviceaccount.com
 *   FIREBASE_PRIVATE_KEY   the key's "private_key" (literal \n sequences are OK)
 * Missing vars fail loudly at cold start with a clear message (names only).
 */
const admin = require("firebase-admin");

function readServiceAccount() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const missing = [
    !projectId && "FIREBASE_PROJECT_ID",
    !clientEmail && "FIREBASE_CLIENT_EMAIL",
    !privateKey && "FIREBASE_PRIVATE_KEY"
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Firebase Admin is not configured: set ${missing.join(", ")} in the Vercel project env`);
  }
  return { projectId, clientEmail, privateKey };
}

if (!admin.apps.length) {
  const sa = readServiceAccount();
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.projectId });
}

module.exports = admin;
