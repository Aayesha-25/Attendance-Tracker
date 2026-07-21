const redis = require("./redisClient");
const { usersKey, idMapKey, idCounterKey, normalizeId } = require("./keys");

/**
 * Bitmap offsets MUST be plain integers. Real-world identifiers (college
 * ID, in this system's case) are not. This module is the ONLY place that
 * resolves an external identifier to the numeric id used as a
 * SETBIT/GETBIT offset, and the only place that should ever be called to
 * do so — never invent a numeric id anywhere else in the codebase.
 *
 * idmap:{eventId}      STUDENT_ID -> numeric userId   (lookup)
 * users:{eventId}      userId -> JSON({studentId,name}) (reverse lookup / listing)
 * idcounter:{eventId}  auto-increment counter
 */

async function getOrCreateUserId(eventId, studentIdRaw, name) {
  const studentId = normalizeId(studentIdRaw);
  const mapKey = idMapKey(eventId);

  const existing = await redis.hget(mapKey, studentId);
  if (existing !== null) {
    return Number(existing);
  }

  // INCR is atomic in Redis, so concurrent first-time check-ins from two
  // different users can never collide on the same numeric id, even under
  // real concurrent load.
  const newId = await redis.incr(idCounterKey(eventId));

  // HSETNX guards the (rare) race where two concurrent requests for the
  // SAME new student id both miss the HGET above; only the first HSETNX
  // wins, the loser re-reads and uses the winner's id instead of
  // orphaning a counter value.
  const wasSet = await redis.hsetnx(mapKey, studentId, newId);
  if (!wasSet) {
    const winnerId = await redis.hget(mapKey, studentId);
    return Number(winnerId);
  }

  await redis.hset(
    usersKey(eventId),
    String(newId),
    JSON.stringify({ studentId, name: name || studentId })
  );

  return newId;
}

async function getUserProfile(eventId, userId) {
  const raw = await redis.hget(usersKey(eventId), String(userId));
  if (!raw) return null;
  return JSON.parse(raw);
}

async function listUsers(eventId) {
  const all = await redis.hgetall(usersKey(eventId));
  return Object.entries(all).map(([id, json]) => ({
    userId: Number(id),
    ...JSON.parse(json),
  }));
}

module.exports = { getOrCreateUserId, getUserProfile, listUsers };
