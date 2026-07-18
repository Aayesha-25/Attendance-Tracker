const redis = require("./redisClient");
const { dayKey, idMapKey } = require("./keys");
const roster = require("./rosterService");
const authService = require("./authService");

/**
 * Answers "who's present and who's absent, right now, for this event" by
 * combining three things:
 *   1. The FULL roster (every student who's supposed to exist)
 *   2. Whether each roster ID has actually created an account yet
 *   3. Whether that account's bitmap bit is set for the given day
 *
 * A roster ID with no account yet is unambiguously absent — they can't
 * have checked in without logging in first, so there's no bit to check.
 * This is the query that powers the coordinator's default dashboard view,
 * and at 200 registrants it gets refreshed repeatedly live during the
 * event, so it's built as 3 fixed Redis round trips total (roster SMEMBERS,
 * idmap HGETALL, one HMGET for every account) — never N round trips that
 * scale with roster size.
 */
async function getDayStatus(eventId, dateStr) {
  const rosterIds = await roster.listRoster();
  const idMap = await redis.hgetall(idMapKey(eventId)); // studentId -> numeric userId, for this event
  const dayBitmapKey = dayKey(eventId, dateStr);

  const idsWithMapping = rosterIds.filter((id) => idMap[id] !== undefined);
  const pipeline = redis.pipeline();
  idsWithMapping.forEach((id) => pipeline.getbit(dayBitmapKey, Number(idMap[id])));
  const bitResults = idsWithMapping.length ? await pipeline.exec() : [];

  const presentSet = new Set();
  idsWithMapping.forEach((id, i) => {
    const [, bit] = bitResults[i];
    if (bit === 1) presentSet.add(id);
  });

  // Single HMGET for every roster account instead of N sequential HGETs —
  // one Redis round trip regardless of whether the roster has 30 or 2000.
  const accounts = rosterIds.length ? await authService.getAccountsByIds(rosterIds) : [];

  const present = [];
  const absent = [];

  rosterIds.forEach((id, i) => {
    const account = accounts[i];
    const entry = {
      studentId: id,
      name: account ? account.name : null,
      registered: Boolean(account),
      userId: idMap[id] !== undefined ? Number(idMap[id]) : null,
    };
    if (presentSet.has(id)) present.push(entry);
    else absent.push(entry);
  });

  present.sort((a, b) => a.studentId.localeCompare(b.studentId));
  absent.sort((a, b) => a.studentId.localeCompare(b.studentId));

  return {
    date: dateStr,
    totalRoster: rosterIds.length,
    presentCount: present.length,
    absentCount: absent.length,
    present,
    absent,
  };
}

module.exports = { getDayStatus };
