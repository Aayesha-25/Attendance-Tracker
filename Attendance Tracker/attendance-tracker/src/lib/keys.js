/**
 * Central place for the Redis key schema. If this schema ever needs to
 * change, it changes here ONLY — never construct keys ad hoc elsewhere.
 *
 *   attendance:{eventId}:day:{YYYY-MM-DD}   -> bitmap, offset = numeric userId
 *   users:{eventId}                         -> hash, userId -> JSON({name,studentId})
 *   idmap:{eventId}                         -> hash, STUDENT_ID -> numeric userId
 *   idcounter:{eventId}                     -> string/int, auto-increment counter
 *   overlap:tmp:{eventId}:{requestId}       -> scratch bitmap for BITOP, short TTL
 */

/**
 * Student ID format: optional single letter prefix, 2-digit year, 2-3
 * letter branch code, 3-digit roll number. Covers all four shapes:
 *   25CE113   25DCE113   D25CE113   D25DCE113
 */
const STUDENT_ID_REGEX = /^[A-Za-z]?\d{2}[A-Za-z]{2,3}\d{3}$/;

function isValidStudentId(id) {
  return typeof id === "string" && STUDENT_ID_REGEX.test(id.trim());
}

/** Canonical form for any identifier used as a Redis hash/set key — one
 * consistent case so "25ce113" and "25CE113" are always the same record. */
function normalizeId(id) {
  return String(id).trim().toUpperCase();
}

function dayKey(eventId, dateStr) {
  return `attendance:${eventId}:day:${dateStr}`;
}

function usersKey(eventId) {
  return `users:${eventId}`;
}

function idMapKey(eventId) {
  return `idmap:${eventId}`;
}

function idCounterKey(eventId) {
  return `idcounter:${eventId}`;
}

function overlapScratchKey(eventId, requestId) {
  return `overlap:tmp:${eventId}:${requestId}`;
}

// Server-local Date/toISOString() is UTC. For an Indian college, "today"
// at 00:15 IST is still 18:45 UTC the PREVIOUS day — using raw UTC here
// would silently mark a midnight check-in against the wrong day. Instead
// we shift by a configurable offset (default IST, UTC+5:30) before taking
// the date slice, so "today" matches what a person on campus expects.
const TZ_OFFSET_MINUTES = Number(process.env.EVENT_TZ_OFFSET_MINUTES ?? 330); // +330 = IST

/** Returns YYYY-MM-DD for "now" (or a given Date), in the configured event timezone. */
function toDateStr(date = new Date()) {
  const shifted = new Date(date.getTime() + TZ_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Validates YYYY-MM-DD format strictly (no month=13, no Feb 30, etc). */
function isValidDateStr(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && toDateStr(d) === dateStr;
}

const MAX_RANGE_DAYS = 366; // one full event-year; prevents unbounded-range abuse

/** Inclusive list of YYYY-MM-DD strings between start and end. Throws if the
 * range exceeds MAX_RANGE_DAYS, so callers can turn that into a 400 instead
 * of the server silently doing unbounded work. */
function dateRange(startStr, endStr) {
  const out = [];
  let cur = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr + "T00:00:00Z");
  while (cur <= end) {
    if (out.length >= MAX_RANGE_DAYS) {
      throw new RangeError(`date range exceeds maximum of ${MAX_RANGE_DAYS} days`);
    }
    out.push(toDateStr(cur));
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}

module.exports = {
  dayKey,
  usersKey,
  idMapKey,
  idCounterKey,
  overlapScratchKey,
  toDateStr,
  isValidDateStr,
  dateRange,
  isValidStudentId,
  normalizeId,
  STUDENT_ID_REGEX,
};
