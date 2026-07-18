const redis = require("./redisClient");
const { normalizeId } = require("./keys");

/**
 * The roster is the closed allow-list of student IDs who are actually
 * eligible to register — it represents "already in the college's
 * database", not "anyone who shows up". A coordinator populates this
 * BEFORE students can create accounts; registration checks membership
 * here and rejects anyone not on it.
 *
 *   roster:allowed_ids   Set of normalized (uppercase) student IDs
 */
const ROSTER_KEY = "roster:allowed_ids";

async function addToRoster(ids) {
  const normalized = ids.map((id) => normalizeId(id)).filter((id) => id.length > 0);
  if (normalized.length === 0) return 0;
  return redis.sadd(ROSTER_KEY, ...normalized);
}

async function removeFromRoster(id) {
  return redis.srem(ROSTER_KEY, normalizeId(id));
}

async function isOnRoster(id) {
  const result = await redis.sismember(ROSTER_KEY, normalizeId(id));
  return result === 1;
}

async function rosterSize() {
  return redis.scard(ROSTER_KEY);
}

async function listRoster() {
  return redis.smembers(ROSTER_KEY);
}

module.exports = { addToRoster, removeFromRoster, isOnRoster, rosterSize, listRoster };
