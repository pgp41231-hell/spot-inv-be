// EPIC-04 / US-05A + US-05B: rule-based alternative-slot suggestions.
//
// Deliberately a transparent heuristic rather than a model: every suggestion can
// be explained to a student in one sentence ("same day, off-peak"), which is what
// the story asks for, and it needs no training data or extra infrastructure.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// India has no daylight saving, so a fixed offset is exact rather than an approximation.
export const IST_OFFSET_MINUTES = 330;

// Campus peak hours: early-morning and evening practice. Everything else is off-peak.
export const PEAK_WINDOWS = [
  { fromHour: 6, toHour: 9 },
  { fromHour: 17, toHour: 21 },
];

// The bookable band of a day, in IST. Suggestions are never made outside it.
export const BOOKABLE_FROM_HOUR = 6;
export const BOOKABLE_TO_HOUR = 23;

export const DEFAULT_STEP_MINUTES = 30;
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_LIMIT = 3;

const toMs = (value) => new Date(value).getTime();

/** Minutes since IST midnight for an instant. */
export function istMinutesOfDay(value) {
  const shifted = toMs(value) + IST_OFFSET_MINUTES * MINUTE;
  return Math.floor((shifted % DAY) / MINUTE);
}

/** Whole IST days since the epoch — used to tell "same day" from "next day". */
export function istDayIndex(value) {
  return Math.floor((toMs(value) + IST_OFFSET_MINUTES * MINUTE) / DAY);
}

/** Build the instant at a given IST day index and minute-of-day. */
export function fromIstParts(dayIndex, minutesOfDay) {
  return new Date(dayIndex * DAY + minutesOfDay * MINUTE - IST_OFFSET_MINUTES * MINUTE);
}

export function isPeak(value) {
  const hour = istMinutesOfDay(value) / 60;
  return PEAK_WINDOWS.some((window) => hour >= window.fromHour && hour < window.toHour);
}

/** Half-open overlap, matching the `[)` semantics of the database exclusion constraint. */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return toMs(aStart) < toMs(bEnd) && toMs(aEnd) > toMs(bStart);
}

function isBlockedBy(intervals, startAt, endAt) {
  return intervals.some((item) => overlaps(startAt, endAt, item.startAt, item.endAt));
}

/**
 * Suggest alternative slots of identical duration that clash with nothing.
 *
 * Every input is plain data, so this runs identically in a unit test, in the
 * request handler, and (mirrored) in the frontend fallback.
 *
 * @returns {Array<{startAt: string, endAt: string, score: number, peak: boolean, reasons: string[]}>}
 *          Up to `limit` suggestions, best first. Empty when nothing qualifies —
 *          the caller renders the US-05D fallback rather than treating it as an error.
 */
export function recommendSlots({
  startAt,
  endAt,
  occupied = [],
  blackouts = [],
  holds = [],
  windowDays = DEFAULT_WINDOW_DAYS,
  limit = DEFAULT_LIMIT,
  stepMinutes = DEFAULT_STEP_MINUTES,
  now = new Date(),
} = {}) {
  const requestedStart = toMs(startAt);
  const requestedEnd = toMs(endAt);
  const duration = requestedEnd - requestedStart;
  if (!Number.isFinite(duration) || duration <= 0) return [];

  const nowMs = toMs(now);
  const requestedPeak = isPeak(requestedStart);
  const requestedDay = istDayIndex(requestedStart);
  const requestedMinutes = istMinutesOfDay(requestedStart);
  const busy = [...occupied, ...blackouts, ...holds];

  const candidates = [];
  for (let dayOffset = 0; dayOffset <= windowDays; dayOffset += 1) {
    const dayIndex = requestedDay + dayOffset;
    const lastStart = BOOKABLE_TO_HOUR * 60 - duration / MINUTE;
    for (let minutes = BOOKABLE_FROM_HOUR * 60; minutes <= lastStart; minutes += stepMinutes) {
      const candidateStart = fromIstParts(dayIndex, minutes);
      const candidateEnd = new Date(candidateStart.getTime() + duration);

      if (candidateStart.getTime() <= nowMs) continue;
      if (candidateStart.getTime() === requestedStart) continue;
      if (isBlockedBy(busy, candidateStart, candidateEnd)) continue;

      const candidatePeak = isPeak(candidateStart);
      const clockDelta = Math.abs(minutes - requestedMinutes);
      const reasons = [];

      // Sooner is better, and by a wide enough margin that a same-day slot always
      // beats a next-day one no matter how well the next-day slot scores otherwise.
      let score = 100 - dayOffset * 50;
      reasons.push(dayOffset === 0 ? "Same day" : dayOffset === 1 ? "Next day" : `In ${dayOffset} days`);

      if (requestedPeak && !candidatePeak) {
        score += 40;
        reasons.push("Off-peak — quieter and usually approved faster");
      } else if (candidatePeak === requestedPeak) {
        score += 10;
        reasons.push(candidatePeak ? "Same peak window" : "Off-peak, like your original request");
      }

      // Closeness to the originally requested time of day, worth at most 20 —
      // deliberately less than the off-peak bonus, so peak congestion wins the argument.
      score += Math.max(0, 20 - clockDelta / 15);
      if (clockDelta === 0) reasons.push("Exactly the time you asked for");

      candidates.push({
        startAt: candidateStart.toISOString(),
        endAt: candidateEnd.toISOString(),
        score: Math.round(score * 100) / 100,
        peak: candidatePeak,
        reasons,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || toMs(a.startAt) - toMs(b.startAt));
  return candidates.slice(0, limit);
}

/** One-line explanation for the API's `meta.reason`, so clients need no lookup table. */
export function describeRecommendations(results, { requestedPeak }) {
  if (results.length === 0) {
    return "No alternative slots are free in the next few days for that duration.";
  }
  return requestedPeak
    ? "Your slot falls in a peak window, so quieter off-peak times are suggested first."
    : "The closest free slots of the same length are suggested first.";
}
