# Requirements interpretation

## Product intent

The backend supports a responsive IIM Lucknow sports operations portal for current students, faculty, non-teaching staff, and the Sports Committee. It replaces phone calls, paper registers, and fragmented WhatsApp updates with a single system of record.

## Source epics and user stories

The workbook defines 19 user stories across three epics:

- Epic A - platform and booking foundation: schema/access architecture; booking engine integration; space registry; space administration; governance/reporting; permissions administration; quality and deployment alignment.
- Epic B - users and experiences: institutional SSO; automatic requester onboarding; requester workspace; approver workspace; public availability; mobile oversight; cross-platform integration.
- Epic C - workflow and controls: configurable routing; sequential approvals; approval reminders; booking status communication; append-only audit history.

The product-vision document adds five sports-facing modules:

- Sports Committee contact information
- Recent-events gallery
- Live fixtures and scores for Sangram, Mahasangram, and Sangharsh
- Sports venue booking
- Sports equipment reservation and condition tracking

## Version 1 boundaries

Payments, fines, a native mobile app, alumni/inter-college access, and automated referee assignment are intentionally excluded. The backend assumes institutional OpenID Connect/JWT authentication, committee-maintained inventories, designated scorekeepers, and a browser-based frontend.

## Implementation decisions

- Node.js 20+ with Express, deployed as one Vercel Function.
- Temporary demo mode uses in-memory data and a no-login demo admin identity so the frontend can be built immediately. Data is not durable in this mode.
- PostgreSQL and institutional OIDC/JWT are deferred launch integrations; Neon through Vercel Marketplace is the recommended database provider.
- Roles are requester, approver, scorekeeper, and admin.
- Venue overlaps are blocked at both application and database levels. Equipment reservations observe available quantity.
- Approval flows can be default-per-resource-type or resource-specific and contain ordered steps.
- Public availability deliberately omits requester identity, booking purpose, and private metadata.
- Notifications use an outbox and a Vercel cron dispatcher. The default daily schedule works on the Hobby plan; it can be increased on Pro. The email provider is connected later through a webhook.
- Audit history is append-only; the database rejects updates and deletes to audit rows.

## Known integration inputs still required

- The institute identity provider's issuer, audience, and JWKS URL
- A production PostgreSQL connection string
- The approved email delivery service/webhook
- Final venue/equipment inventory and committee member data
- Approval owners and rules for each venue category
- A media-storage/CDN choice for gallery assets; the API stores media URLs, not file blobs
