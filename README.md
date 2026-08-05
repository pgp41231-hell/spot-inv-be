# IIM Lucknow Sports Operations API

Node.js backend for the future sports portal frontend. It covers venue and equipment reservations, conflict prevention, approval chains, public availability, committee content, event galleries, fixtures/live scores, role administration, utilization reporting, notifications, and audit history.

## Run locally

Requirements: Node.js 20+ and pnpm/npm.

1. Copy `.env.example` to `.env`. It starts in `AUTH_MODE=demo`, so no login setup is needed.
2. Install dependencies with `pnpm install`.
3. Run `pnpm dev`.
4. Open `http://localhost:3000/api/v1/health`.

Without `DATABASE_URL`, the API uses an in-memory store and data resets on restart or between Vercel serverless instances. This is intentional for the temporary demo deployment.

For local development authentication, send these headers:

```text
x-user-id: user-123
x-user-email: user@example.edu
x-user-name: Example User
x-user-role: requester | approver | scorekeeper | admin
```

The deployed demo defaults to an admin identity. It is for development only; switch to OIDC before storing real user data.

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
2. Deploy with no environment variables for temporary demo mode, then verify `/api/v1/health` and `/openapi.yaml`.
3. Before a real launch, add a PostgreSQL provider, configure `DATABASE_URL` and OIDC values, run the migration/seed, and set `AUTH_MODE=oidc`.

Vercel detects the Express export in `api/index.js`. Add the Vercel cron configuration only after an email provider and `CRON_SECRET` are configured.

## API groups

- Public: venues, equipment, privacy-safe availability, committee members, gallery, tournaments, matches
- Authenticated: profile, searchable resources, personal bookings
- Approver: pending queue and sequential decisions
- Scorekeeper: fixture and live-score updates
- Admin: users/roles, resources, blackout windows, approval flows, content, utilization, audit log

The machine-readable contract is in `public/openapi.yaml`. The source-to-backend interpretation is in `docs/requirements-summary.md`.
