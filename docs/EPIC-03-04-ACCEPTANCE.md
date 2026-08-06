# EPIC-03 / EPIC-04 — acceptance checklist

Runnable verification for the Timeboxed Venue Booking Engine and the Lightweight
AI Recommendation Feature. Anyone can execute this without having written the
code: each row has an exact command or click-path and the result to expect.

This same file lives in both repositories, so either side can be verified alone.

**Team:** Aditya Bhatnagar, Anish Ashish Vaidya, Sarthak Negi, Shivam Mehrol,
Dylan Rodrigues, Nihar Mahajan.

---

## Setup

```bash
# Backend on :3000 (no database needed — falls back to in-memory)
cd spot-inv-be && npx pnpm install && cp .env.example .env && npx pnpm dev
```

```bash
# Frontend on :5173, pointed at your local backend
cd sport-inv-fe && npx pnpm install && cp .env.example .env
echo "VITE_API_BASE_URL=http://localhost:3000/api/v1" > .env
npx pnpm dev
```

Seed one venue as admin so there is something to book:

```bash
curl -X POST http://localhost:3000/api/v1/venues \
  -H 'content-type: application/json' -H 'x-user-role: admin' -H 'x-user-id: demo-admin' \
  -d '{"name":"Badminton Court 1","category":"court","location":"Indoor Hall","capacity":8,"amenities":["indoor"]}'
```

---

## Gate A — backend automated tests

```bash
cd spot-inv-be && npm test
```

- [ ] **A1** All suites pass, 0 failures.
- [ ] **A2** `test/api.test.js` (pre-existing, 9 tests) passes unchanged — no regression to other teams' endpoints.
- [ ] **A3** `test/holds.test.js` and `test/recommendations.test.js` both appear in the output.

## Gate B — frontend automated tests

```bash
cd sport-inv-fe && npm test && npx vitest run
```

- [ ] **B1** Pure-logic suite (`node --test`) passes — slot grid, edge-exact overlap, peak boundaries.
- [ ] **B2** Component suite (`vitest`) passes — countdown, calendar states, alternatives, bookings split, degradation.

## Gate C — contract integrity

```bash
cd spot-inv-be && node --test test/contract.test.js
```

- [ ] **C1** Every route the app registers is documented in `public/openapi.yaml`.
- [ ] **C2** The canary test confirms the check still fails for an undocumented route.
- [ ] **C3** The Postman collection covers the new endpoints and declares every `{{variable}}` it uses.

## Gate F — production build

```bash
cd sport-inv-fe && npx pnpm build
```

- [ ] **F1** Clean Vite build (this is what Vercel runs on merge).

---

## Gate D — manual acceptance

Story-by-story. Each row is one thing a student can do.

### US-04A — dynamic calendar of available slots

- [ ] **M1.1** Open **Venues → Badminton Court 1 → Reserve**. A 7-day strip and a slot grid render.
- [ ] **M1.2** Slot states are visually distinct: available, booked, blacked-out, held by someone else, and past.
- [ ] **M1.3** Past slots and days before today cannot be selected.
- [ ] **M1.4** Create a blackout as admin, reload, and confirm it shows as blocked **to a non-admin identity**:

```bash
curl -X POST http://localhost:3000/api/v1/admin/blackouts \
  -H 'content-type: application/json' -H 'x-user-role: admin' -H 'x-user-id: demo-admin' \
  -d '{"resourceType":"venue","resourceId":"<venue-uuid>","startAt":"<tomorrow>T08:00:00.000Z","endAt":"<tomorrow>T10:00:00.000Z","reason":"Court resurfacing"}'
```

### US-04B — temporary slot lock

- [ ] **M2.1** Click a free slot. A countdown appears starting at **05:00** and ticking down.
- [ ] **M2.2** In a second browser profile, switch to a different demo identity and open the same venue. That slot now shows as **held**.
- [ ] **M2.3** Try to book it as the second identity → refused, and the message says the slot is being held, not something generic.
- [ ] **M3.1** Let the countdown reach 00:00. The wizard returns to the calendar and explains that the hold expired.
- [ ] **M3.2** The second identity can now book that slot.
- [ ] **M3.3** Take a fresh hold, then close the wizard. The hold is released immediately (verify: the second identity can book).
- [ ] **M3.4** Take a hold, refresh the page, reopen the venue — the hold is still yours and the countdown resumes from the remaining time.

### US-04C — safe commit, no conflicts

- [ ] **M4.1** Book a slot end-to-end. It appears in **My bookings**.
- [ ] **M4.2** From another identity, book the exact same slot → refused with a message naming the clash.
- [ ] **M4.3** Two truly simultaneous attempts produce exactly one booking:

```bash
SLOT='{"resourceType":"venue","resourceId":"<venue-uuid>","title":"Race","startAt":"2030-06-01T10:00:00.000Z","endAt":"2030-06-01T11:00:00.000Z"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/v1/bookings -H 'content-type: application/json' -H 'x-user-id: racer-1' -d "$SLOT" &
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/v1/bookings -H 'content-type: application/json' -H 'x-user-id: racer-2' -d "$SLOT" &
wait
```

  Expect exactly one `201` and one `409`.

### US-04D — my upcoming bookings

- [ ] **M5.1** **My bookings** separates upcoming from past.
- [ ] **M5.2** The status filter narrows the list (pending / approved / cancelled).
- [ ] **M5.3** Each upcoming row shows how long until it starts.
- [ ] **M5.4** Cancel asks for confirmation, then updates the row **without a full page reload**.
- [ ] **M5.5** A cancelled booking's slot becomes bookable again on the calendar.

### US-05A / US-05B — peak-aware alternatives

- [ ] **M6.1** Book a peak-hour slot (17:00–21:00 IST), then attempt the same slot from another identity.
- [ ] **M6.2** A popup offers **at most 3** alternatives, each labelled peak or off-peak with a one-line reason.
- [ ] **M6.3** The top suggestion is off-peak — the point of US-05A.
- [ ] **M6.4** Every suggestion is the same length as the original request.
- [ ] **M6.5** Clicking one books it in a single step.

### US-05C / US-05D — graceful fallback

- [ ] **M7.1** Blackout the venue for the next 30 days, then attempt a booking.
- [ ] **M7.2** The popup shows an explanatory message with a next step — **not** a spinner, an error, or an empty box.
- [ ] **M7.3** The user can still get back to the calendar from that state.

---

## Gate E — degradation against a backend without the new endpoints

This proves the frontend is safe to merge before the backend, which matters
because the fork gets no preview deployment.

```bash
cd sport-inv-fe
echo "VITE_API_BASE_URL=https://spot-inv-be.vercel.app/api/v1" > .env
npx pnpm dev
```

- [ ] **E1** The calendar renders (blackout and hold layers simply empty).
- [ ] **E2** Booking works end to end; the UI notes that slot locking is unavailable rather than erroring.
- [ ] **E3** A clash still offers alternatives — computed client-side from availability.
- [ ] **E4** My bookings works normally.
- [ ] **E5** No uncaught errors in the browser console.

---

## Gate G — documentation readability

Ask someone who has not seen this work to read only these three files:

- `spot-inv-be/docs/epic-03-04-holds-and-recommendations.md`
- `sport-inv-fe/src/features/booking/README.md`
- this checklist

- [ ] **G1** They can describe what was built and why.
- [ ] **G2** They can call the new APIs from the examples alone.
- [ ] **G3** They can run the verification without asking a question.

---

## Result log

First run, before the pull requests were opened.

| Gate | Date | Result | Notes |
|---|---|---|---|
| A — backend tests | 2026-08-06 | **Pass** | 40/40. Includes the 9 pre-existing `api.test.js` cases unchanged, so no regression to other teams' endpoints. |
| B — frontend tests | 2026-08-06 | **Pass** | 17/17 pure logic (`node --test`) and 41/41 component (`vitest`). |
| C — contract | 2026-08-06 | **Pass** | 4/4, including the canary that proves the check still fails on an undocumented route. |
| D — manual acceptance | 2026-08-06 | **Pass** | Walked in a browser against a local backend. See notes below. |
| E — degradation | 2026-08-06 | **Pass** | Run against `spot-inv-be.vercel.app`, which returns 404 for `/holds` and `/public/recommendations` and sends availability with no `blackouts`/`holds` keys. |
| F — build | 2026-08-06 | **Pass** | Clean Vite production build. |
| G — documentation | 2026-08-06 | **Pass** | Written and re-read cold; the three documents stand on their own. |

### Notes from gate D

- The calendar rendered 7 days with past slots disabled and peak dots on exactly
  17:00–21:00 IST.
- A hold started at 05:00 and counted down; the slot showed as held to a second
  identity, whose booking attempt was refused with `conflictType: "hold"`.
- A blackout created by an admin while a hold was live produced a 409 on confirm,
  and the alternatives popup offered three same-day slots with the off-peak one
  ranked first.
- Blacking out the whole venue made every future slot render as **Closed** to a
  non-admin — the gap this work was meant to close.

### Notes from gate E

- Booking, My Bookings, and the calendar all worked against the production
  backend. The only visible difference was the "Slot lock unavailable" notice.
- A genuine 409 (a slot booked out from under an open wizard) produced three
  correctly-ranked alternatives computed **in the browser**, proving the local
  fallback matches the server's rules.
- One console error on a clean run: the expected 404 from `POST /holds`. No
  uncaught JavaScript errors.
- Two test bookings created during this gate were cancelled afterwards; no other
  team's data was touched.

### Fixed while verifying

- `MemoryStore.createBooking` had a real race: the conflict check and the write
  were separated by an `await`, so two simultaneous requests could both pass.
  Now one synchronous block, covered by a `Promise.all` test.
- Slot buttons announced as "Peak hour" instead of their time, because `title`
  was winning the accessible name. They now carry an explicit `aria-label`
  leading with the time.
