# Slot holds & recommendations (EPIC-03 / EPIC-04)

Backend changes for the Timeboxed Venue Booking Engine and the Lightweight AI
Recommendation Feature.

If you have never opened this repository before, read this file top to bottom —
it should take about ten minutes and leave you able to call every new endpoint.

---

## 1. What problem this solves

The API already let you create a booking and refused overlapping ones. Two gaps
made the booking experience worse than the phone calls it replaces:

**Gap 1 — nothing protects you while you fill in the form.** Two students could
open the same slot, both spend a minute typing a title and purpose, and one of
them would lose. Nothing had gone wrong technically; the loser simply wasted
their time. *(US-04B)*

**Gap 2 — a refusal was a dead end.** A clash returned `409 CONFLICT` and a
sentence. The student was left to guess when the venue might be free, so they
re-tried by hand until something stuck. *(US-05B, US-05C, US-05D)*

A third, smaller gap turned up while building the calendar: **blackouts were
invisible to students**, because `GET /admin/blackouts` requires an admin. The
calendar would have shown a maintenance window as bookable and only revealed the
truth after a failed attempt.

---

## 2. What was added

| Capability | Endpoint(s) | Story |
|---|---|---|
| Hold a slot for five minutes | `POST /holds`, `GET /holds/mine`, `DELETE /holds/:id` | US-04B |
| See which slots others are holding | `GET /public/holds` | US-04B |
| Suggest alternative slots | `GET /public/recommendations` | US-05A, US-05B |
| Blackout + hold layers for the calendar | `GET /public/availability` (extended) | US-04A |
| Consume a hold when booking; alternatives on a clash | `POST /bookings` (extended) | US-04B, US-04C, US-05C |

Both extended endpoints are **backwards compatible**: `availability` keeps its
`data` array exactly as it was and adds sibling keys, and `holdId` on a booking
is optional, so any existing client keeps working untouched.

---

## 3. Data model

One new table, `slot_holds` (`db/migrations/002_slot_holds.sql`):

| Column | Why it exists |
|---|---|
| `resource_type`, `resource_id`, `start_at`, `end_at` | the slot being claimed |
| `held_by` | who claimed it — never exposed publicly |
| `quantity` | equipment holds reserve stock, exactly like bookings |
| `expires_at` | set to `now() + 5 minutes` on creation |
| `released_at` | set when released early, or when converted into a booking |
| `booking_id` | the booking a hold turned into, for auditing |

### Why expiry is passive

Every read filters `released_at IS NULL AND expires_at > now()`. There is no
cron job, no sweeper, and no background timer.

This matters more than it sounds. A sweeper introduces a window where an expired
hold still blocks people because the job has not run yet, and it is one more
thing that can be silently broken during a demo. Filtering at read time means a
hold stops blocking at the exact instant it lapses, whatever else is or is not
running. Rows accumulate, which is the trade — they are small, indexed, and can
be pruned later if it ever matters.

`scripts/migrate.js` now runs **every** `.sql` file in `db/migrations` in
filename order, not just `001_init.sql`. All migrations are idempotent
(`IF NOT EXISTS`, guarded `DO` blocks), so `vercel-build` re-running them on
every deploy is safe.

---

## 4. API reference

All examples assume demo auth (`x-user-*` headers). Replace `$BASE` with
`http://localhost:3000` or `https://spot-inv-be.vercel.app`.

### `POST /api/v1/holds` — claim a slot

```bash
curl -X POST "$BASE/api/v1/holds" \
  -H 'content-type: application/json' \
  -H 'x-user-id: requester-1' -H 'x-user-email: requester-1@iiml.ac.in' -H 'x-user-role: requester' \
  -d '{
    "resourceType": "venue",
    "resourceId": "<venue-uuid>",
    "startAt": "2027-05-10T10:00:00.000Z",
    "endAt": "2027-05-10T11:00:00.000Z"
  }'
```

```json
{
  "data": {
    "id": "8f2c…", "resourceType": "venue", "resourceId": "66169b26…",
    "heldBy": "requester-1", "quantity": 1,
    "startAt": "2027-05-10T10:00:00.000Z", "endAt": "2027-05-10T11:00:00.000Z",
    "expiresAt": "2027-05-10T09:05:00.000Z", "releasedAt": null, "bookingId": null
  },
  "meta": { "ttlMinutes": 5 }
}
```

`409` if the slot is already booked, blacked out, or held by someone else. The
`error.details.conflict.conflictType` says which.

### `GET /api/v1/holds/mine` — recover after a refresh

Returns your live holds. The frontend calls this on load so a page refresh does
not orphan a hold the user is still working on.

### `DELETE /api/v1/holds/:id` — release early

Owner or admin only; a stranger gets `403`. Releasing frees the slot immediately.

### `GET /api/v1/public/holds` — what others are holding

```bash
curl "$BASE/api/v1/public/holds?resourceType=venue&resourceId=<venue-uuid>"
```

```json
{
  "data": [{ "id": "8f2c…", "resourceType": "venue", "resourceId": "66169b26…",
             "startAt": "…", "endAt": "…", "expiresAt": "…" }],
  "meta": { "ttlMinutes": 5 }
}
```

No `heldBy`. The calendar needs to know a slot is spoken for, not who is taking
it — the same privacy line `publicBookingView` already draws for bookings.

### `GET /api/v1/public/recommendations` — alternatives

```bash
curl "$BASE/api/v1/public/recommendations?resourceType=venue&resourceId=<uuid>\
&startAt=2027-05-10T12:30:00.000Z&endAt=2027-05-10T13:30:00.000Z&limit=3"
```

```json
{
  "data": [
    { "startAt": "2027-05-10T05:30:00.000Z", "endAt": "2027-05-10T06:30:00.000Z",
      "score": 154, "peak": false,
      "reasons": ["Same day", "Off-peak — quieter and usually approved faster"] }
  ],
  "meta": {
    "requestedPeak": true,
    "windowDays": 7,
    "reason": "Your slot falls in a peak window, so quieter off-peak times are suggested first."
  }
}
```

**An empty `data` array is a valid answer, not an error** (US-05D). Render
`meta.reason`; do not show a spinner or an error state.

### `GET /api/v1/public/availability` — extended

`data` is unchanged. Two keys were added so the calendar can draw every layer
from one request:

```json
{
  "data":      [{ "id": "…", "startAt": "…", "endAt": "…", "status": "approved" }],
  "blackouts": [{ "id": "…", "startAt": "…", "endAt": "…", "reason": "Exams" }],
  "holds":     [{ "id": "…", "startAt": "…", "endAt": "…", "expiresAt": "…" }]
}
```

### `POST /api/v1/bookings` — extended

- Optional `holdId`. It must belong to you (`403` otherwise), still be live
  (`400` if expired), and cover this exact slot (`400` if the times were edited).
  On success the hold is marked consumed. Omitting it books normally.
- A `409` now carries up to three `alternatives` in `error.details`, so the
  frontend can offer a way out without a second round-trip (US-05C).

---

## 5. How the recommendation heuristic works

`src/recommendations.js`. It is a plain rules engine, not a model — every
suggestion can be explained to a student in one sentence, which is what US-05A
asks for and what makes it defensible in a demo.

**Peak windows** are 06:00–09:00 and 17:00–21:00 IST. Everything else is
off-peak. India has no daylight saving, so a fixed +5:30 offset is exact.

**Candidates** are every 30-minute start between 06:00 and 23:00 IST, for the
requested day and the following seven, each keeping the requested duration
exactly. Anything in the past, anything identical to the original request, and
anything overlapping a booking, blackout or live hold is discarded.

**Ranking**, highest first:

| Factor | Weight | Rationale |
|---|---|---|
| Days away | `100 − 50 × days` | Sooner is far more useful; the weight is large enough that a same-day slot always beats a next-day one |
| Off-peak, when the request was peak-blocked | `+40` | The clash was probably caused by peak congestion, so move them out of it |
| Same peak/off-peak band as requested | `+10` | Respect the kind of time they asked for |
| Closeness to the original clock time | up to `+20` | Deliberately smaller than the off-peak bonus, so congestion wins the argument |
| Earlier start | tiebreak | |

Each result carries a `reasons` array of plain-English strings. `score` is for
ranking only and is not meaningful on its own — do not show it to users.

The same function serves both the recommendations endpoint and the `409` on
booking, so the two can never disagree.

---

## 6. Design decisions, and what was rejected

**Holds are advisory, not authoritative.** A hold is a courtesy that prevents
wasted effort. The booking — and the `no_overlapping_venue_booking` GiST
exclusion constraint behind it — remains the only source of truth. A bug in hold
handling can waste someone's time; it cannot create a double booking.

**No Redis or distributed lock.** That would add infrastructure, a failure mode,
and a cost line to a system whose contention is a handful of students clicking
the same badminton court. A table row with an expiry does the same job with
nothing new to operate.

**No exclusion constraint on `slot_holds`.** Tempting, but wrong: the constraint
would have to encode "unreleased and unexpired", which is time-dependent, and
Postgres exclusion constraints cannot reference `now()`. Enforcing it in the
query keeps the rule in one readable place.

**A race in `MemoryStore.createBooking` was fixed along the way.** The conflict
check and the write were separated by an `await`, so two simultaneous requests
could both pass the check before either wrote. They are now one synchronous
block. Postgres was never affected — the exclusion constraint caught it — but
the in-memory demo mode was, and `test/holds.test.js` now proves it.

**A rules engine, not a model,** for recommendations. There is no historical
booking data to train on, an unexplainable suggestion is worse than none in an
approval workflow, and the rules took an afternoon.

---

## 7. Known limits

- A hold is tied to a **user**, not a browser session. The same person on two
  devices shares their holds. Fine for the current demo identities; revisit when
  institutional SSO lands.
- The five-minute TTL is a constant (`HOLD_TTL_MINUTES` in `src/holds.js`), not
  configurable per venue. Venues with long approval discussions may want longer.
- Recommendations assume a 06:00–23:00 bookable day for every venue. Per-venue
  opening hours belong in `venues.rules`, which this does not yet read.
- Recommendations look at one resource. "This court is busy, try the other one"
  needs cross-venue search, which is a natural next step.
- Expired hold rows are never deleted. Harmless at campus scale; a periodic
  `DELETE FROM slot_holds WHERE expires_at < now() - interval '7 days'` would do.

---

## 8. Running the tests

```bash
npm test
```

Everything runs against `MemoryStore`, so **no database is required**.

| File | What it proves |
|---|---|
| `test/holds.test.js` | The lock actually locks: another person's hold blocks with `conflictType: "hold"`, your own does not block you, an expired hold blocks nobody, a stranger cannot release your hold, public holds never leak `heldBy`, and two simultaneous bookings produce exactly one winner |
| `test/recommendations.test.js` | Peak requests get off-peak answers, same-day outranks next-day, duration is preserved, past and occupied slots are never suggested, and a saturated window returns `[]` rather than throwing |
| `test/contract.test.js` | Every route the app registers is documented in `openapi.yaml`, and the Postman collection declares every variable it uses. Includes a canary test so the check cannot rot into a no-op |
| `test/api.test.js` | Pre-existing suite, unchanged — proves this work did not regress other teams' endpoints |

For a manual walkthrough, see [`EPIC-03-04-ACCEPTANCE.md`](./EPIC-03-04-ACCEPTANCE.md).
For clicking through the API, import `postman/Spot-InV-BE.postman_collection.json`
and run folder **12 — Slot Holds and Recommendations** after folder 03.
