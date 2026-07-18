const express = require("express");
const router = express.Router();

const { isValidDateStr, toDateStr } = require("../lib/keys");
const { getOrCreateUserId, getUserProfile, listUsers } = require("../lib/userIdentity");
const attendanceService = require("../lib/attendanceService");
const adminOverviewService = require("../lib/adminOverviewService");
const { requireAuth, requireRole } = require("../middleware/auth");

// ---- helpers -------------------------------------------------------------

function requireEventId(req, res) {
  const eventId = req.query.event_id || req.body.event_id;
  if (!eventId || typeof eventId !== "string") {
    res.status(400).json({ error: "event_id is required" });
    return null;
  }
  return eventId;
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// ---- POST /checkin ---------------------------------------------------
// Body: { event_id, date? }. Identity comes from the verified JWT, NEVER
// from the request body — this is the fix for the core problem: without
// it, anyone could POST any identity and check attendance in for someone
// else. Now the token you're logged in as IS the person being marked
// present; there is no identity field to spoof.
// date defaults to today. Idempotent — re-checking-in same day is a 200,
// not a 409, since a network retry hitting this twice should never
// surface as an error to the caller.
router.post("/checkin", requireAuth, async (req, res, next) => {
  try {
    const { event_id, date } = req.body;
    const { studentId, name } = req.user; // from verified token, not the body

    if (!event_id) return badRequest(res, "event_id is required");

    const dateStr = date || toDateStr();
    if (!isValidDateStr(dateStr)) return badRequest(res, "date must be YYYY-MM-DD");

    // Reject future-dated check-ins. Without this, a client bug (or a
    // deliberately tampered request) can pre-mark attendance for a day
    // that hasn't happened yet — a real integrity issue for an actual
    // attendance record, not just a cosmetic validation gap.
    if (dateStr > toDateStr()) {
      return badRequest(res, "cannot check in for a future date");
    }

    const userId = await getOrCreateUserId(event_id, studentId, name);
    const { alreadyCheckedIn } = await attendanceService.checkIn(event_id, userId, dateStr);

    res.status(200).json({ userId, eventId: event_id, date: dateStr, alreadyCheckedIn });
  } catch (err) {
    next(err);
  }
});

// ---- DELETE /checkin ---------------------------------------------------
// Body: { event_id, user_id, date }. Corrects a mistaken check-in.
// Admin-only: this mutates someone else's attendance record.
router.delete("/checkin", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { event_id, user_id, date } = req.body;
    if (!event_id) return badRequest(res, "event_id is required");

    const userId = Number(user_id);
    if (!Number.isInteger(userId) || userId < 0) {
      return badRequest(res, "user_id must be a non-negative integer");
    }
    if (!date || !isValidDateStr(date)) return badRequest(res, "date must be YYYY-MM-DD");

    const result = await attendanceService.undoCheckIn(event_id, userId, date);
    res.json({ eventId: event_id, userId, date, ...result });
  } catch (err) {
    next(err);
  }
});

// ---- GET /me/id?event_id= ------------------------------------------------
// Resolves the CALLER's own numeric userId for an event, creating the
// identity mapping if this is their first interaction with the event —
// but never touching attendance bits. Exists so a client can load "my
// stats" on page load without a throwaway check-in just to learn its id.
router.get("/me/id", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireEventId(req, res);
    if (!eventId) return;

    const userId = await getOrCreateUserId(eventId, req.user.studentId, req.user.name);
    res.json({ eventId, userId });
  } catch (err) {
    next(err);
  }
});

// ---- GET /day-status?event_id=&date= -----------------------------------
// Admin-only. The default coordinator view: every roster ID split into
// present / absent for a given day (today, if not specified), computed
// against the FULL roster — not just accounts that happen to exist yet.
router.get("/day-status", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const eventId = requireEventId(req, res);
    if (!eventId) return;

    const date = req.query.date || toDateStr();
    if (!isValidDateStr(date)) return badRequest(res, "date must be YYYY-MM-DD");

    const result = await adminOverviewService.getDayStatus(eventId, date);
    res.json({ eventId, ...result });
  } catch (err) {
    next(err);
  }
});

// ---- GET /day/:date/count?event_id=... --------------------------------
router.get("/day/:date/count", async (req, res, next) => {
  try {
    const eventId = requireEventId(req, res);
    if (!eventId) return;

    const { date } = req.params;
    if (!isValidDateStr(date)) return badRequest(res, "date must be YYYY-MM-DD");

    const count = await attendanceService.getDayCount(eventId, date);
    res.json({ eventId, date, count });
  } catch (err) {
    next(err);
  }
});

// ---- GET /user/:userId/stats?event_id=&start=&end= --------------------
// A student may view their OWN stats; only an admin may view someone
// else's. This is checked AFTER loading the profile (need to compare
// IDs), not via a role-only gate — self-service is exactly what a
// student-facing attendance feature needs.
router.get("/user/:userId/stats", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireEventId(req, res);
    if (!eventId) return;

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId < 0) {
      return badRequest(res, "userId must be a non-negative integer");
    }

    const { start, end } = req.query;
    if (!start || !end || !isValidDateStr(start) || !isValidDateStr(end)) {
      return badRequest(res, "start and end query params (YYYY-MM-DD) are required");
    }
    if (start > end) return badRequest(res, "start must be <= end");

    const profile = await getUserProfile(eventId, userId);
    if (!profile) return res.status(404).json({ error: "user not found for this event" });

    const isOwner = profile.studentId === req.user.studentId;
    if (!isOwner && req.user.role !== "admin") {
      return res.status(403).json({ error: "you can only view your own attendance stats" });
    }

    const stats = await attendanceService.getUserStats(eventId, userId, start, end);
    res.json({ eventId, userId, ...profile, ...stats });
  } catch (err) {
    if (err instanceof RangeError) return badRequest(res, err.message);
    next(err);
  }
});

// ---- GET /overlap?event_id=&dates=2026-01-01,2026-01-02 ---------------
router.get("/overlap", async (req, res, next) => {
  try {
    const eventId = requireEventId(req, res);
    if (!eventId) return;

    const datesRaw = req.query.dates;
    if (!datesRaw) return badRequest(res, "dates query param is required (comma-separated)");

    const dates = String(datesRaw).split(",").map((d) => d.trim());
    for (const d of dates) {
      if (!isValidDateStr(d)) return badRequest(res, `invalid date: ${d}`);
    }
    const uniqueDates = [...new Set(dates)];
    if (uniqueDates.length < 2) {
      return badRequest(res, "provide at least 2 distinct dates to compute overlap");
    }

    const count = await attendanceService.getOverlapCount(eventId, dates);
    res.json({ eventId, dates, overlapCount: count });
  } catch (err) {
    next(err);
  }
});

// ---- GET /grid?event_id=&start=&end= -----------------------------------
router.get("/grid", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const eventId = requireEventId(req, res);
    if (!eventId) return;

    const { start, end } = req.query;
    if (!start || !end || !isValidDateStr(start) || !isValidDateStr(end)) {
      return badRequest(res, "start and end query params (YYYY-MM-DD) are required");
    }
    if (start > end) return badRequest(res, "start must be <= end");

    const data = await attendanceService.getGrid(eventId, start, end);
    res.json({ eventId, ...data });
  } catch (err) {
    if (err instanceof RangeError) return badRequest(res, err.message);
    next(err);
  }
});

// ---- GET /users?event_id= ------------------------------------------------
router.get("/users", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const eventId = requireEventId(req, res);
    if (!eventId) return;

    const users = await listUsers(eventId);
    res.json({ eventId, users });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
