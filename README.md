# Ronna Scanner API

Backend for the ronnascanner.com tools. Plain Vercel Node functions (CommonJS).
Paid-only: every data route needs an active Pro or Team plan. There is no unpaid tier.
Early access is granted with Stripe promotion codes at checkout.

**Status:** hardened, not deployed. It needs keys (see `.env.example`, names only)
and the Principal's deploy GO. Deploy with Stripe **test** keys first.

## Routes

| Route | Auth | Notes |
|---|---|---|
| `POST /api/leads/scan` | Firebase ID token + paid plan | Apollo company search. Fields come from Apollo or are `null`. No invented score. |
| `POST /api/emails/find` | Firebase ID token + paid plan | Hunter email finder (`mode: "find"`). `verify` and `bulk` return 501 (not built). |
| `POST /api/contacts/find` | none | **501, not built yet** |
| `POST /api/companies/scan` | none | **501, not built yet** |
| `POST /api/prospects/research` | none | **501, not built yet** |
| `POST /api/payment/create-session` | Firebase ID token | Stripe Checkout redirect. `{ priceId: "pro" \| "team", tool? }` |
| `POST /api/payment/create-embedded-session` | Firebase ID token | Stripe Embedded Checkout, same body |
| `POST /api/payment/portal` | Firebase ID token | Billing portal for the caller's own account only |
| `POST /api/payment/webhook` | Stripe signature | Raw-body verified. Writes `subscriptions/{uid}`, deduped by event id. |
| `GET /health` | none | Booleans only: which env groups are set, plus the Stripe mode |

Anything else, including `/docs` and `/openapi*`, returns a JSON 404.

## Security model

- **CORS:** an explicit allowlist (`https://ronnascanner.com` + the 5 `https://<tool>.ronnascanner.com`). It sends `Vary: Origin`, never reflects an origin, and never sends credentials. The planned hosting proxies each tool's same-origin `/api/*` here with a Vercel rewrite.
- **Auth:** Firebase ID tokens for project `mdo3d-leads`. Anonymous tokens are refused. Handlers act only on the token's uid; a body or query `userId` that names another account gets a 403.
- **Checkout:** the price must be `pro` / `team` or an id in `STRIPE_PRO_PRICE_IDS` / `STRIPE_TEAM_PRICE_IDS`. Client amounts and redirect URLs are refused with a 400. Success and cancel pages are fixed at `https://<tool>.ronnascanner.com/success.html` and `/cancel.html`.
- **Paywall:** `lib/quota.js` `withQuota`. Without an active paid plan the route returns 402 `subscription_required` before any data-provider call. Paid calls are counted in `usage/{uid}_{YYYY-MM}`. Firestore rules must deny client writes to `usage/*` and `subscriptions/*`.
- **Error contract:** JSON errors use the codes 400 / 401 / 402 / 403 / 404 / 405 / 409 / 413 / 429 / 501 / 502 / 503. Internal messages are never echoed. Rate limits apply to every paid and payment route.

## Tests

```bash
npm install
npm test        # node:test; Stripe, Firebase, Apollo and Hunter are stubbed; no network
```
