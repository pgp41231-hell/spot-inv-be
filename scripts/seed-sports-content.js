// Seeds the sports-content endpoints (committee, tournaments, matches,
// standings, gallery) with exactly what the frontend's demo data currently
// shows — see sport-inv-fe's src/features/{committee,tournaments,fixtures}/
// demoData.js, which this is a deliberate one-time copy of. The point: once
// this has run against a real deployment, an admin sees the *same* page
// they see today, except every card is now real, persisted, and editable —
// nothing visually changes, only what's backing it does.
//
// Unlike scripts/seed.js (which writes straight to a store instance, since
// it has to run before any admin account or auth exists), this one talks to
// a *running* server over HTTP, the same way any client would — everything
// it creates goes through the same validation, role checks, and audit
// logging a real admin's request would.
//
// Usage:
//   BASE_URL=http://localhost:3000/api/v1 \
//   ADMIN_EMAIL=sports@iiml.ac.in ADMIN_PASSWORD=sports@iiml.ac.in \
//   FRONTEND_BASE_URL=http://localhost:5173 \
//   node scripts/seed-sports-content.js
//
// All four env vars have local-dev defaults (see below) and can be omitted
// when running against the local AUTH_MODE=password/in-memory setup from
// the README. Set FRONTEND_BASE_URL to the real deployed frontend's origin
// when seeding a real deployment, so the Sangram 2025 photo URLs resolve —
// gallery.mediaUrl only stores a URL, it doesn't host the image itself.
//
// Idempotent by inspection, not by an --force flag: each section checks
// what already exists (by email for committee, by name for tournaments) and
// only creates what's missing, so running this twice never duplicates rows.
// Matches/standings are the exception — they're skipped entirely for a
// tournament that already has any, since there's no natural per-row key to
// de-duplicate against; delete them first if you want to reseed from
// scratch.

const BASE_URL = process.env.BASE_URL || "http://localhost:3000/api/v1";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "sports@iiml.ac.in";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "sports@iiml.ac.in";
const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || "http://localhost:5173").replace(/\/$/, "");

async function request(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${payload?.error?.message || "request failed"}`);
  return payload;
}

const login = async (email, password) => (await request("/auth/login", { method: "POST", body: { email, password } })).data;

// --- Committee ---------------------------------------------------------------
// Exact copy of COMMITTEE_DEMO (sport-inv-fe/src/features/committee/demoData.js).
const COMMITTEE = [
  { name: "Nirav Mithari", title: "Secretary", tags: ["Cricket", "Football"], email: "pgp41433@iiml.ac.in", phone: "+91 82753 60699" },
  { name: "Abhinav Choudhary", title: "Member", tags: ["Badminton"], email: "abm22001@iiml.ac.in", phone: "+91 70422 93772" },
  { name: "Aditya Tidke", title: "Member", tags: ["Basketball", "Volleyball"], email: "pgp41120@iiml.ac.in", phone: "+91 91197 47736" },
  { name: "Alisha Lakra", title: "Member", tags: ["Table Tennis"], email: "pgp40297@iiml.ac.in", phone: "+91 91234 93245" },
  { name: "Kevin Fernandes", title: "Member", tags: ["Football", "Cricket"], email: "pgp41133@iiml.ac.in", phone: "+91 97696 43745" },
  { name: "Manan Dhoke", title: "Member", tags: ["Volleyball"], email: "pgp41488@iiml.ac.in", phone: "+91 70665 01050" },
  { name: "Mebansan Makri", title: "Member", tags: ["Basketball"], email: "pgp41491@iiml.ac.in", phone: "+91 82579 56729" },
  { name: "P Vyshnav Shenoy", title: "Member", tags: ["Badminton", "Table Tennis"], email: "pgp41269@iiml.ac.in", phone: "+91 96339 10540" },
  { name: "Piyush Borse", title: "Member", tags: ["Cricket"], email: "pgp41471@iiml.ac.in", phone: "+91 91461 13529" },
  { name: "Ragul R", title: "Member", tags: ["Football", "Basketball"], email: "pgp41214@iiml.ac.in", phone: "+91 93611 42749" },
  { name: "Ritu Baskey", title: "Member", tags: ["Table Tennis", "Volleyball"], email: "pgp41216@iiml.ac.in", phone: "+91 89450 98731" },
  { name: "Sarthak Tomar", title: "Member", tags: ["Badminton", "Cricket"], email: "pgp41440@iiml.ac.in", phone: "+91 70891 56440" },
];

// --- Tournaments ---------------------------------------------------------------
// "Sangram" (the upcoming one FIXTURES_DEMO's matches all belong to) is
// seeded as status "live" rather than "published" -- it's what today's
// fixtures and the points table attach to, and "live" still shows in the
// Upcoming box exactly like "published" would (see adapters.js's
// splitTournaments: everything except "completed" reads as upcoming). The
// other two upcoming ones, and all six past ones, are exact copies of
// UPCOMING_TOURNAMENTS_DEMO / PAST_TOURNAMENTS_DEMO.
const UPCOMING = [
  { name: "Sangram", blurb: "Flagship inter-section tournament", startsOn: "2026-09-12", status: "live" },
  { name: "Mahasangram", blurb: "Postgraduate championship", startsOn: "2026-10-24", status: "published" },
  { name: "Hell's League", blurb: "Late-night 5-a-side football", startsOn: "2026-11-08", status: "published" },
];
const PAST = [
  {
    name: "Sangram 2025", blurb: "Last-over drama under the lights", startsOn: "2025-09-14", venue: "Sports Complex", status: "completed",
    description: "Sangram 2025 brought the whole campus out for four days of cricket, football, and badminton, capped by a last-over cricket final that went down to the wire.",
    photos: ["1.jpeg", "2.jpeg", "3.jpeg", "4.jpeg", "5.jpeg"].map((file) => `${FRONTEND_BASE_URL}/tournaments/sangram-2025/${file}`),
  },
  {
    name: "Sangram 2024", blurb: "PGP-1 United's unbeaten run", startsOn: "2024-09-08", venue: "Sports Complex", status: "completed",
    description: "PGP-1 United went unbeaten through the group stage and the knockouts alike, anchoring Sangram 2024's football competition from start to finish.",
  },
  {
    name: "Mahasangram 2024", blurb: "Smash Championship semi-final", startsOn: "2024-10-19", venue: "Indoor Courts", status: "completed",
    description: "The postgraduate championship's badminton draw came down to a three-set Smash Championship semi-final that had the indoor courts packed past capacity.",
  },
  {
    name: "Hell's League 2024", blurb: "Midnight knockout football", startsOn: "2024-11-30", venue: "Football Turf", status: "completed",
    description: "A midnight knockout football league that lived up to its name — floodlit five-a-side matches running well past 1 AM across three straight weekends.",
  },
  {
    name: "Varchasva 2024", blurb: "Hostel league tip-off", startsOn: "2024-08-22", venue: "Basketball Court", status: "completed",
    description: "The hostel league's basketball tip-off kicked off Varchasva 2024, with every hostel fielding a team across a full round-robin season.",
  },
  {
    name: "Sangharsh 2024", blurb: "Campus track & field", startsOn: "2024-07-15", venue: "Campus Track", status: "completed",
    description: "Sangharsh 2024 turned the campus track into the main stage for a full day of athletics — sprints, relays, and distance events back to back.",
  },
];

// --- Fixtures (matches) --------------------------------------------------------
// Exact copy of FIXTURES_DEMO. startsAt values are just spread across "now
// plus a few days" in order -- none of this frontend's UI displays startsAt
// for these directly (it reads the human-written `notes`/`stage` instead),
// so the precise timestamp doesn't matter, only that it's a valid one.
const now = Date.now();
const hoursFromNow = (hours) => new Date(now + hours * 3_600_000).toISOString();
const FIXTURES = [
  { sport: "badminton", stage: "Men's Singles - Semifinal", venue: "Indoor Court 2", status: "live", homeTeam: "Arjun Mehta", awayTeam: "Rohan Iyer", homeScore: "21 . 18 . 11", awayScore: "15 . 21 . 9", notes: "3rd game, 11-9", startsAt: hoursFromNow(-1) },
  { sport: "cricket", stage: "Group B - League match", venue: "Main Cricket Ground", status: "live", homeTeam: "Section B", awayTeam: "Section D", homeScore: "142/6", awayScore: "Yet to bat", notes: "18.3 overs - Section B batting", startsAt: hoursFromNow(-2) },
  { sport: "football", stage: "Quarterfinal", venue: "Football Turf", status: "live", homeTeam: "Section A", awayTeam: "Section C", homeScore: "2", awayScore: "1", notes: "72' - Second half", startsAt: hoursFromNow(-1.5) },
  { sport: "table tennis", stage: "Women's Doubles - Quarterfinal", venue: "Indoor Court 1", status: "scheduled", homeTeam: "Priya & Kavya", awayTeam: "Meera & Sana", notes: "Tomorrow - 5:00 PM", startsAt: hoursFromNow(24) },
  { sport: "basketball", stage: "Group A - League match", venue: "Basketball Court", status: "scheduled", homeTeam: "Section E", awayTeam: "Section F", notes: "Thu - 6:30 PM", startsAt: hoursFromNow(48) },
  { sport: "volleyball", stage: "Group C - League match", venue: "Volleyball Court", status: "scheduled", homeTeam: "Section G", awayTeam: "Section H", notes: "Fri - 4:00 PM", startsAt: hoursFromNow(72) },
  { sport: "badminton", stage: "Men's Doubles - Quarterfinal", venue: "Indoor Court 1", status: "completed", homeTeam: "Karan Shah & Dev Patel", awayTeam: "Rohan Iyer & Aman Gupta", homeScore: "21 . 19", awayScore: "15 . 21", notes: "Karan Shah & Dev Patel won 2-0", startsAt: hoursFromNow(-24) },
  { sport: "cricket", stage: "Group A - League match", venue: "Main Cricket Ground", status: "completed", homeTeam: "Section A", awayTeam: "Section E", homeScore: "168/7", awayScore: "142/9", notes: "Section A won by 26 runs", startsAt: hoursFromNow(-30) },
];

// --- Standings (points table) --------------------------------------------------
// Exact copy of POINTS_TABLE_DEMO, pivoted from its wide {section, scores}
// shape into the long {section, sport, points} rows the backend stores.
const POINTS_TABLE = [
  { section: "Section A", scores: { badminton: 12, cricket: 8, football: 18, tableTennis: 6, basketball: 10, volleyball: 9 } },
  { section: "Section B", scores: { badminton: 9, cricket: 15, football: 7, tableTennis: 11, basketball: 8, volleyball: 12 } },
  { section: "Section C", scores: { badminton: 14, cricket: 6, football: 12, tableTennis: 9, basketball: 13, volleyball: 7 } },
  { section: "Section D", scores: { badminton: 7, cricket: 10, football: 9, tableTennis: 14, basketball: 6, volleyball: 15 } },
  { section: "Section E", scores: { badminton: 11, cricket: 9, football: 8, tableTennis: 7, basketball: 16, volleyball: 6 } },
  { section: "Section F", scores: { badminton: 6, cricket: 12, football: 10, tableTennis: 8, basketball: 9, volleyball: 11 } },
  { section: "Section G", scores: { badminton: 8, cricket: 7, football: 11, tableTennis: 13, basketball: 7, volleyball: 10 } },
  { section: "Section H", scores: { badminton: 10, cricket: 11, football: 6, tableTennis: 9, basketball: 8, volleyball: 8 } },
  { section: "Section I", scores: { badminton: 5, cricket: 8, football: 9, tableTennis: 6, basketball: 11, volleyball: 9 } },
];

async function main() {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  console.log(`Logged in as ${admin.user.email} (${admin.user.role})`);
  const token = admin.token;

  const existingCommittee = (await request("/public/committee")).data;
  const existingEmails = new Set(existingCommittee.map((item) => item.email));
  let committeeCreated = 0;
  for (const member of COMMITTEE) {
    if (existingEmails.has(member.email)) continue;
    await request("/committee", { method: "POST", token, body: member });
    committeeCreated++;
  }
  console.log(`Committee: created ${committeeCreated}, already had ${COMMITTEE.length - committeeCreated}`);

  // The authenticated endpoint, not /public/tournaments -- the public one
  // filters out drafts, which would make this check blind to any draft
  // tournament and re-create it forever.
  const existingTournaments = (await request("/tournaments", { token })).data;
  const existingNames = new Map(existingTournaments.map((item) => [item.name, item]));
  const ensureTournament = async (spec) => {
    const found = existingNames.get(spec.name);
    if (found) return found;
    const { photos, ...tournamentBody } = spec;
    const created = (await request("/tournaments", { method: "POST", token, body: tournamentBody })).data;
    existingNames.set(spec.name, created);
    return created;
  };

  let tournamentsCreated = 0;
  for (const spec of [...UPCOMING, ...PAST]) {
    const before = existingNames.has(spec.name);
    const record = await ensureTournament(spec);
    if (!before) tournamentsCreated++;
    if (spec.photos?.length) {
      const existingPhotos = (await request(`/public/gallery?tournamentId=${record.id}`)).data;
      if (existingPhotos.length === 0) {
        for (const mediaUrl of spec.photos) {
          await request("/gallery", { method: "POST", token, body: { title: `${spec.name} photo`, mediaUrl, tournamentId: record.id } });
        }
        console.log(`  ${spec.name}: added ${spec.photos.length} photos`);
      }
    }
  }
  console.log(`Tournaments: created ${tournamentsCreated}, already had ${UPCOMING.length + PAST.length - tournamentsCreated}`);

  const sangram = existingNames.get("Sangram");
  const existingMatches = (await request(`/public/matches?tournamentId=${sangram.id}`)).data;
  if (existingMatches.length === 0) {
    for (const fixture of FIXTURES) {
      const { homeScore, awayScore, ...rest } = fixture;
      await request("/matches", {
        method: "POST", token,
        body: {
          ...rest, tournamentId: sangram.id,
          homeScore: homeScore ? { text: homeScore } : {},
          awayScore: awayScore ? { text: awayScore } : {},
        },
      });
    }
    console.log(`Fixtures: created ${FIXTURES.length}`);
  } else {
    console.log(`Fixtures: skipped, ${sangram.name} already has ${existingMatches.length}`);
  }

  const existingStandings = (await request(`/public/standings?tournamentId=${sangram.id}`)).data;
  if (existingStandings.length === 0) {
    let standingsCreated = 0;
    for (const row of POINTS_TABLE) {
      for (const [sport, points] of Object.entries(row.scores)) {
        await request("/standings", { method: "POST", token, body: { tournamentId: sangram.id, section: row.section, sport, points } });
        standingsCreated++;
      }
    }
    console.log(`Standings: created ${standingsCreated}`);
  } else {
    console.log(`Standings: skipped, ${sangram.name} already has ${existingStandings.length}`);
  }

  console.log("Done.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
