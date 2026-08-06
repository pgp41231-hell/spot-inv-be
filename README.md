# IIM Lucknow Sports Operations API

Node.js backend for the future sports portal frontend. It covers venue and equipment reservations, conflict prevention, approval chains, public availability, committee content, event galleries, fixtures/live scores, role administration, utilization reporting, notifications, and audit history.

## Run locally

Requirements: Node.js 20+ and pnpm/npm.

1. Copy `.env.example` to `.env`. It starts in `AUTH_MODE=demo`, so no login setup is needed.
2. Install dependencies with `pnpm install`.
3. Run `pnpm dev`.
4. Open `http://localhost:3000/api/v1/health`.

Without `DATABASE_URL` (or the `POSTGRES_URL` supplied by the Supabase Vercel integration), the API uses an in-memory store and data resets on restart or between Vercel serverless instances. This is intentional for the temporary demo deployment.

For local development authentication, send these headers:

```text
x-user-id: user-123
x-user-email: user@example.edu
x-user-name: Example User
x-user-role: requester | approver | scorekeeper | admin
```

The deployed demo defaults to an admin identity. It is for development only; switch to OIDC before storing real user data.

## Database

For Supabase, set `DATABASE_URL` to the **Transaction pooler** connection URL (port `6543`) in Vercel Project Settings > Environment Variables. If Supabase was installed from the Vercel Marketplace and connected to this project, Vercel injects `POSTGRES_URL` and no duplicate variable is needed. Vercel deployments run the idempotent schema migration automatically through the `vercel-build` script. A deployment now fails if no database URL is available, preventing accidental use of temporary in-memory storage.

To run the migration manually, use a direct connection URL:

```bash
DIRECT_DATABASE_URL="your Supabase direct connection URL" pnpm db:migrate
pnpm db:seed
```

On Windows PowerShell, use `$env:DIRECT_DATABASE_URL="your Supabase direct connection URL"; pnpm db:migrate`. Keep `AUTH_MODE=demo` until OAuth is introduced, then redeploy after adding or changing environment variables. The health response reports `storage: "postgres"` when the deployed function receives the database configuration.

The migration creates the relational model, overlap constraints, approval workflow, notification outbox, indexes, and append-only audit guard. Set `SEED_ADMIN_SUB`, `SEED_ADMIN_EMAIL`, and `SEED_ADMIN_NAME` before seeding if desired.

## Test

```bash
pnpm test
```

The tests exercise the API with the in-memory adapter and cover permissions, privacy, venue/equipment conflicts, blackouts, approvals, and audit history.

## Deploy to Vercel

1. Push this directory to a Git provider or run `vercel` from the project root.
2. Deploy with no environment variables for temporary demo mode, then verify `/api/v1/health` and `/openapi.yaml`.
3. Before a real launch, add a PostgreSQL provider, configure `DATABASE_URL` and OIDC values, run the migration/seed, and set `AUTH_MODE=oidc`.

Vercel routes all requests to the Express export in `api/index.js` using the rewrite in `vercel.json`. Add the Vercel cron configuration only after an email provider and `CRON_SECRET` are configured.

## API groups

- Public: venues, equipment, privacy-safe availability, committee members, gallery, tournaments, matches
- Authenticated: profile, searchable resources, personal bookings
- Approver: pending queue and sequential decisions
- Scorekeeper: fixture and live-score updates
- Admin: users/roles, resources, blackout windows, approval flows, content, utilization, audit log

The machine-readable contract is in `public/openapi.yaml`. The source-to-backend interpretation is in `docs/requirements-summary.md`.

## Slot holds and recommendations (EPIC-03 / EPIC-04)

Two capabilities were added for the Timeboxed Venue Booking Engine and the
Lightweight AI Recommendation Feature:

- **Slot holds (US-04B)** — `POST /api/v1/holds` claims a slot for five minutes
  while the requester fills in the booking form, so two people cannot both spend
  a minute typing and have one of them lose. Holds are advisory and expire
  passively; the booking and its overlap constraint remain the source of truth.
  See also `GET /api/v1/holds/mine`, `DELETE /api/v1/holds/:id`, and the
  anonymised `GET /api/v1/public/holds`.
- **Alternative slots (US-05A/B)** — `GET /api/v1/public/recommendations` returns
  up to three non-conflicting slots of the same duration, preferring same-day and
  off-peak times, each with a plain-English reason. An empty list is a valid
  answer, not an error.

`GET /api/v1/public/availability` now also returns `blackouts` and `holds` so a
calendar can draw every layer from one request, and `POST /api/v1/bookings`
accepts an optional `holdId` and returns `alternatives` alongside a `409`. Both
changes are backwards compatible.

Full write-up, including the ranking rules and the design decisions behind them:
[`docs/epic-03-04-holds-and-recommendations.md`](docs/epic-03-04-holds-and-recommendations.md).
Verification checklist: [`docs/EPIC-03-04-ACCEPTANCE.md`](docs/EPIC-03-04-ACCEPTANCE.md).
