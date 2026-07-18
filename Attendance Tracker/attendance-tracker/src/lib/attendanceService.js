const crypto = require("crypto");
const redis = require("./redisClient");
const { dayKey, overlapScratchKey, toDateStr, dateRange } = require("./keys");
const { listUsers } = require("./userIdentity");

/**
 * Marks a user present for a given day. Idempotent: checking in twice on
 * the same day is a no-op the second time (SETBIT just re-sets the same
 * bit to 1), so callers never need to special-case "already checked in"
 * as an error.
 */
async function checkIn(eventId, userId, dateStr) {
  const key = dayKey(eventId, dateStr);
  const previousBit = await redis.setbit(key, userId, 1);
  return { alreadyCheckedIn: previousBit === 1 };
}

/**
 * Corrects a mistaken check-in (wrong day, buddy-punch, fat-finger).
 * Without this, a single bad SETBIT is permanent — every real attendance
 * system needs an undo path, and this one didn't have one until now.
 */
async function undoCheckIn(eventId, userId, dateStr) {
  const key = dayKey(eventId, dateStr);
  const previousBit = await redis.setbit(key, userId, 0);
  return { wasCheckedIn: previousBit === 1 };
}

/** Total number of distinct users present on a given day. */
async function getDayCount(eventId, dateStr) {
  const key = dayKey(eventId, dateStr);
  return redis.bitcount(key);
}

/** Whether a specific user was present on a specific day. */
async function wasPresent(eventId, userId, dateStr) {
  const key = dayKey(eventId, dateStr);
  const bit = await redis.getbit(key, userId);
  return bit === 1;
}

/**
 * Total days present + longest consecutive streak for one user across a
 * date range. Redis has no native "longest run of set bits" primitive, so
 * this is computed in application code from per-day GETBIT reads — that's
 * a deliberate, honest choice, not a workaround (see README).
 *
 * Uses a pipeline so the N GETBIT calls are sent in a single round trip
 * instead of N sequential network calls — this is the difference between
 * an O(days) network-bound loop and one that's actually fast at scale.
 */
async function getUserStats(eventId, userId, startDate, endDate) {
  const days = dateRange(startDate, endDate);
  const pipeline = redis.pipeline();
  days.forEach((d) => pipeline.getbit(dayKey(eventId, d), userId));
  const results = await pipeline.exec();

  const presentFlags = results.map(([err, bit]) => {
    if (err) throw err;
    return bit === 1;
  });

  let totalDaysPresent = 0;
  let longestStreak = 0;
  let currentRun = 0;
  let currentStreak = 0; // streak ending on the LAST day in range

  presentFlags.forEach((present, idx) => {
    if (present) {
      totalDaysPresent += 1;
      currentRun += 1;
      longestStreak = Math.max(longestStreak, currentRun);
    } else {
      currentRun = 0;
    }
    if (idx === presentFlags.length - 1) currentStreak = currentRun;
  });

  return {
    totalDaysPresent,
    longestStreak,
    currentStreak,
    daysInRange: days.length,
    dailyBreakdown: days.map((d, i) => ({ date: d, present: presentFlags[i] })),
  };
}

/**
 * Users present on ALL given days (intersection), computed with a single
 * Redis-side BITOP AND rather than pulling data into app code — this is
 * the flagship "why bitmaps" demo moment. Result is written to a short-TTL
 * scratch key so BITCOUNT (and, if needed, inspecting individual bits) can
 * both run without recomputing.
 */
async function getOverlapCount(eventId, dateStrs) {
  // A previous version used Date.now() here. Two concurrent /overlap
  // requests in the same millisecond (trivial under real load) would
  // collide on the same scratch key and corrupt each other's result.
  // crypto.randomUUID() makes collision cryptographically negligible.
  const scratchKey = overlapScratchKey(eventId, crypto.randomUUID());
  const uniqueDates = [...new Set(dateStrs)];
  const sourceKeys = uniqueDates.map((d) => dayKey(eventId, d));

  await redis.bitop("AND", scratchKey, ...sourceKeys);
  const count = await redis.bitcount(scratchKey);
  await redis.expire(scratchKey, 30); // scratch key, no reason to keep it

  return count;
}

/**
 * Grid data for the frontend heatmap: every known user x every day in
 * range, present/absent. Pipelines all GETBITs (users * days calls) into
 * one round trip.
 */
async function getGrid(eventId, startDate, endDate) {
  const days = dateRange(startDate, endDate);
  const users = await listUsers(eventId);

  const pipeline = redis.pipeline();
  users.forEach((u) => {
    days.forEach((d) => pipeline.getbit(dayKey(eventId, d), u.userId));
  });
  const results = await pipeline.exec();

  let i = 0;
  const grid = users.map((u) => {
    const row = days.map((d) => {
      const [, bit] = results[i++];
      return { date: d, present: bit === 1 };
    });
    return { userId: u.userId, name: u.name, studentId: u.studentId, days: row };
  });

  return { days, grid };
}

module.exports = {
  checkIn,
  undoCheckIn,
  getDayCount,
  wasPresent,
  getUserStats,
  getOverlapCount,
  getGrid,
};
