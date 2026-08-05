# IIM Lucknow Sports Operations API

Node.js backend for the future sports portal frontend. It covers venue and equipment reservations, conflict prevention, approval chains, public availability, committee content, event galleries, fixtures/live scores, role administration, utilization reporting, notifications, and audit history.

## Run locally

Requirements: Node.js 20+ and pnpm/npm.

1. Copy `.env.example` to `.env` and set `ALLOW_DEV_AUTH=true` for local development.
2. Install dependencies with `pnpm install`.
3. Run `pnpm dev`.
4. Open `http://localhost:3000/api/v1/health`.

Without `DATABASE_URL`, development uses an in-memory store and data resets on restart. PostgreSQL is mandatory when `NODE_ENV=production`.

For local development authentication, send these headers:

```text
x-user-id: user-123
x-user-email: user@example.edu
x-user-name: Example User
x-user-role: requester | approver | scorekeeper | admin
```

This mode cannot be enabled in production.

## Database

Set `DATABASE_URL` to a pooled PostgreSQL URL, then run:

```bash
pnpm db:migrate
pnpm db:seed
```

The migration creates the relational model, overlap constraints, approval workflow, notification outbox, indexes, and append-only audit guard. Set `SEED_ADMIN_SUB`, `SEED_ADMIN_EMAIL`, and `SEED_ADMIN_NAME` before seeding if desired.

## Test

```bash
pnpm test
```

The tests exercise the API with the in-memory adapter and cover permissions, privacy, venue/equipment conflicts, blackouts, approvals, and audit history.

## Deploy to Vercel

1. Push this directory to a Git provider or run `vercel` from the project root.
2. Add a PostgreSQL provider (Neon is suitable) from Vercel Marketplace and connect it to the project.
3. Configure `DATABASE_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URI`, `ALLOWED_ORIGINS`, `CRON_SECRET`, and the optional email webhook variables for Production and Preview.
4. Run the migration against the production database, then seed it once.
5. Deploy and verify `/api/v1/health` and `/openapi.yaml`.

Vercel detects the Express export in `api/index.js`. The daily 08:00 UTC cron calls `/api/v1/jobs/reminders`; Vercel sends `CRON_SECRET` as a bearer token when the project cron secret is configured. Pro plans can safely increase the schedule frequency in `vercel.json`.

## API groups

- Public: venues, equipment, privacy-safe availability, committee members, gallery, tournaments, matches
- Authenticated: profile, searchable resources, personal bookings
- Approver: pending queue and sequential decisions
- Scorekeeper: fixture and live-score updates
- Admin: users/roles, resources, blackout windows, approval flows, content, utilization, audit log

The machine-readable contract is in `public/openapi.yaml`. The source-to-backend interpretation is in `docs/requirements-summary.md`.
