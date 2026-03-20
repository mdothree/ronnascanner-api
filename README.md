# RonnaScanner API — Backend Services

Backend API for the **ronnascanner.com** platform. Serverless functions on Vercel.

## Structure

```
ronnascanner-api/
├── api/
│   ├── _middleware/
│   │   ├── auth.js          # Firebase token verification
│   │   └── rateLimit.js     # In-memory rate limiter
│   ├── payment/
│   │   ├── create-session.js          # Stripe Checkout redirect
│   │   ├── create-embedded-session.js # Stripe Embedded Checkout
│   │   ├── webhook.js                 # Stripe webhook → Firestore sync
│   │   └── portal.js                  # Customer billing portal
│   └── lib/
│       └── firebase.js      # Firebase Admin SDK singleton
├── .env.example             # All secret env vars documented
├── package.json
└── vercel.json              # Routes, webhook raw body config, security headers
```

## Setup

```bash
cp .env.example .env.local
# Fill in Firebase Admin credentials, Stripe SECRET keys, and other API keys
vercel --prod
```

## Security

- Firebase token verification on all protected routes via `requireAuth` middleware
- Rate limiting on free tier endpoints
- Stripe webhook signature verification
- All secrets server-side only — never in frontend code
- Security headers (CSP, HSTS, X-Frame-Options) applied globally

## Stripe Webhook

Register `https://your-api.vercel.app/api/payment/webhook` in your Stripe Dashboard.
Events handled: `checkout.session.completed`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
