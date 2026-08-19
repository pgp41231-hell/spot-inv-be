# IIM Lucknow Sports Operations API

Node.js backend for the future sports portal frontend. It covers venue and equipment reservations, conflict prevention, approval chains, public availability, committee content, event galleries, fixtures/live scores, role administration, utilization reporting, notifications, and audit history.

## Run locally

Requirements: Node.js 20+ and pnpm/npm.

1. Copy `.env.example` to `.env` and set the Supabase URL, anon key, service-role key, database URLs, and a long random `QR_TOKEN_SECRET`.
2. Install dependencies with `pnpm install`.
3. Run `pnpm db:migrate`, then `pnpm auth:seed-admin` once.
4. Run `pnpm dev` and open `http://localhost:3000/api/v1/health`.

The equipment module requires PostgreSQL/Supabase and does not have an in-memory adapter. `AUTH_MODE=demo` and the in-memory store remain only for automated tests and the unchanged legacy modules; do not use them for a deployment.

`pnpm auth:seed-admin` creates `sportscomm@iiml.ac.in` through the Supabase Auth admin API. It reads `ADMIN_SEED_PASSWORD`, using the administrator email only when the variable is unset, and never resets an existing account. The seeded profile must change its password on first login. This is the only email that can hold the admin role. Other eligible accounts are students (`requester`) by default; the administrator assigns SportComm members or scorekeepers by email.

The default eligible student rule is `^pgp\d{5}@iiml\.ac\.in$` (case-insensitive). The administrator can replace it in the dashboard; the rule is checked at signup and on every new login so yearly batch access can be rotated without deleting historical users.

`AUTH_MODE=demo` remains available only for automated tests. In that mode, send these headers:

```text
x-user-id: user-123
x-user-email: user@example.edu
x-user-name: Example User
x-user-role: requester | approver | scorekeeper | admin
```

Never deploy with `AUTH_MODE=demo` or `AUTH_MODE=password`. Use `AUTH_MODE=supabase`; the backend validates each bearer token with Supabase Auth and reads the effective role from the profile table.

## Database

For Supabase, set `DATABASE_URL` to the **Transaction pooler** connection URL (port `6543`) in Vercel Project Settings > Environment Variables. If Supabase was installed from the Vercel Marketplace and connected to this project, Vercel injects `POSTGRES_URL` and no duplicate variable is needed. Vercel deployments run the idempotent schema migration automatically through the `vercel-build` script. A deployment now fails if no database URL is available, preventing accidental use of temporary in-memory storage.

To run the migration manually, use a direct connection URL:

```bash
DIRECT_DATABASE_URL="your Supabase direct connection URL" pnpm db:migrate
pnpm db:seed
```

On Windows PowerShell, use `$env:DIRECT_DATABASE_URL="your Supabase direct connection URL"; pnpm db:migrate`. The health response reports `storage: "postgres"` when the deployed function receives the database configuration.

The database is created from one final-state baseline: `db/migrations/001_schema.sql`. It creates the complete application schema, constraints, RLS policies, Supabase Auth profile triggers, the public `sports-media` bucket, and idempotent starter sports, venues, equipment, allocations, and asset tags. It contains no legacy upgrade steps and is intended for a fresh test schema. The migration runner wraps the file in a transaction, so a failure rolls back the entire baseline instead of leaving a half-created database.

## Test

```bash
pnpm test
```

The tests cover the unchanged API behaviour plus signed equipment-token validation. Applying the migration and exercising RLS requires a configured Supabase test project.

## Deploy to Vercel

1. Push this directory to a Git provider or run `vercel` from the project root.
2. Configure the Supabase and database environment variables before deploying; the build applies `001_schema.sql` automatically.
3. Set `AUTH_MODE=supabase`, then verify `/api/v1/health` reports `storage: "postgres"` and open `/openapi.yaml`.

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
