const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const redis = require("./redisClient");
const roster = require("./rosterService");
const { isValidStudentId, normalizeId } = require("./keys");

/**
 * Global account store — deliberately separate from the per-event
 * attendance identity map (idmap:{eventId} in userIdentity.js). An
 * account (studentId + password) exists once across the whole system;
 * the numeric bitmap-offset userId is still resolved per-event via the
 * existing getOrCreateUserId(). This layer answers "who is making this
 * request", not "what's their bitmap offset in event X".
 *
 *   auth:users   hash, STUDENT_ID -> JSON({ passwordHash, name, role, createdAt })
 *
 * Login is by college ID, not email — this is a closed campus system,
 * not a public sign-up, and the ID is the identifier everyone already
 * has memorized.
 */
const AUTH_USERS_KEY = "auth:users";

// Names are attacker-controlled free text that ends up rendered in the
// admin dashboard (day-status, grid). Strip anything that isn't a plain
// display character BEFORE it ever reaches Redis — this is the fix for a
// real stored-XSS: a student registering with name="<img src=x onerror=...>"
// used to come back verbatim in /api/day-status and get injected via
// innerHTML on the admin's screen. Belt-and-suspenders with the frontend
// escaping fix, but this is the one that matters if some OTHER client ever
// reads this same data and forgets to escape.
const MAX_NAME_LENGTH = 60;
function sanitizeName(raw) {
  const stripped = String(raw)
    .replace(/[<>&"'`]/g, "") // no markup-relevant characters at all
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, MAX_NAME_LENGTH);
}

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "12h";

if (!JWT_SECRET) {
  console.error("[auth] FATAL: JWT_SECRET is not set. Set it in your .env before starting the server.");
  process.exit(1);
}

async function register(studentIdRaw, password, name, adminCode) {
  if (!studentIdRaw || typeof studentIdRaw !== "string") {
    const err = new Error("studentId is required");
    err.status = 400;
    throw err;
  }

  const configuredAdminCode = process.env.ADMIN_REGISTRATION_CODE;
  const isAdminSignup = Boolean(configuredAdminCode && adminCode === configuredAdminCode);

  // Student IDs must match the college roll-number format. Admin accounts
  // are exempt — a faculty coordinator's login (e.g. "COORD1") doesn't
  // follow the student roll-number shape, and shouldn't need to.
  if (!isAdminSignup && !isValidStudentId(studentIdRaw)) {
    const err = new Error(
      "invalid student ID format — expected something like 25CE113, 25DCE113, D25CE113, or D25DCE113"
    );
    err.status = 400;
    throw err;
  }

  const studentId = normalizeId(studentIdRaw);

  const existing = await redis.hget(AUTH_USERS_KEY, studentId);
  if (existing) {
    const err = new Error("an account with this ID already exists");
    err.status = 409;
    throw err;
  }

  if (!password || password.length < 8) {
    const err = new Error("password must be at least 8 characters");
    err.status = 400;
    throw err;
  }

  const role = isAdminSignup ? "admin" : "student";

  // Closed roster: a STUDENT can only register if a coordinator has
  // already added their ID to the roster — this is the actual
  // enforcement of "these are students already in the college's
  // database", not an open sign-up system. Admin accounts (verified by
  // the coordinator code instead) are exempt from this check.
  if (!isAdminSignup) {
    const allowed = await roster.isOnRoster(studentId);
    if (!allowed) {
      const err = new Error(
        "this ID is not on the roster — ask your coordinator to add you before registering"
      );
      err.status = 403;
      throw err;
    }
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const safeName = sanitizeName(name || studentId) || studentId;
  const record = { passwordHash, name: safeName, role, createdAt: new Date().toISOString() };

  await redis.hset(AUTH_USERS_KEY, studentId, JSON.stringify(record));

  return { studentId, name: record.name, role };
}

/**
 * Admin bulk-provisions accounts directly — no self-registration step at
 * all. This is the real-world shape for a college event: the coordinator
 * already has a roster with ID+password pairs assigned offline (printed
 * hall tickets, a spreadsheet, whatever), and just needs those accounts
 * to EXIST before the event starts. Participants only ever see a login
 * screen.
 *
 * Each entry also gets added to the roster automatically (provisioning
 * an account IS the roster-approval act here — there's no separate
 * self-serve registration flow left to gate).
 *
 * Returns per-entry results so the admin can see exactly which rows
 * failed and why (bad format, duplicate, weak password) without the
 * whole batch aborting on one bad row.
 */
async function bulkProvision(entries) {
  const results = [];
  const validEntries = [];
  const seenInBatch = new Set();

  for (const entry of entries) {
    const { student_id: rawId, password } = entry;
    if (!rawId || !isValidStudentId(rawId)) {
      results.push({ studentId: rawId, ok: false, error: "invalid ID format" });
      continue;
    }
    const studentId = normalizeId(rawId);
    if (!password || password.length < 8) {
      results.push({ studentId, ok: false, error: "password must be at least 8 characters" });
      continue;
    }
    // A duplicate WITHIN this same paste — without this check, both rows
    // would pass validation and the second HSET would silently overwrite
    // the first, while the response reported both as successful. Only
    // the first occurrence proceeds; every later repeat is flagged.
    if (seenInBatch.has(studentId)) {
      results.push({ studentId, ok: false, error: "duplicate ID within this batch — only the first was used" });
      continue;
    }
    seenInBatch.add(studentId);
    validEntries.push({ studentId, password, name: entry.name });
  }

  if (validEntries.length === 0) return results;

  // One round trip to find which of these already exist, instead of N
  // sequential HGETs — matters once you're doing this for 500 rows.
  const existingRaws = await redis.hmget(AUTH_USERS_KEY, ...validEntries.map((e) => e.studentId));
  const existingSet = new Set(validEntries.filter((_, i) => existingRaws[i] !== null).map((e) => e.studentId));

  const toCreate = validEntries.filter((e) => !existingSet.has(e.studentId));
  validEntries
    .filter((e) => existingSet.has(e.studentId))
    .forEach((e) => results.push({ studentId: e.studentId, ok: false, error: "account already exists" }));

  if (toCreate.length > 0) {
    // Hash concurrently (bcrypt releases the event loop between rounds),
    // then write everything in a single pipelined HSET pass.
    const hashed = await Promise.all(
      toCreate.map(async (e) => ({
        studentId: e.studentId,
        record: {
          passwordHash: await bcrypt.hash(e.password, 10),
          name: sanitizeName(e.name || e.studentId) || e.studentId,
          role: "student",
          createdAt: new Date().toISOString(),
        },
      }))
    );

    const pipeline = redis.pipeline();
    hashed.forEach(({ studentId, record }) => {
      pipeline.hset(AUTH_USERS_KEY, studentId, JSON.stringify(record));
    });
    await pipeline.exec();

    await roster.addToRoster(hashed.map((h) => h.studentId));
    hashed.forEach(({ studentId, record }) => results.push({ studentId, ok: true, name: record.name }));
  }

  return results;
}

async function login(studentIdRaw, password) {
  const studentId = normalizeId(studentIdRaw || "");
  const raw = await redis.hget(AUTH_USERS_KEY, studentId);

  if (!raw) {
    const err = new Error("invalid ID or password");
    err.status = 401;
    throw err;
  }

  const record = JSON.parse(raw);
  const valid = await bcrypt.compare(password, record.passwordHash);

  // Deliberately identical error/status for "no such account" and "wrong
  // password" — distinguishing them lets an attacker enumerate which
  // IDs have registered accounts.
  if (!valid) {
    const err = new Error("invalid ID or password");
    err.status = 401;
    throw err;
  }

  const token = jwt.sign(
    { studentId, name: record.name, role: record.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return { token, studentId, name: record.name, role: record.role };
}

/** Looks up an account's public info (no password hash) by ID, or null. */
async function getAccountById(studentIdRaw) {
  const studentId = normalizeId(studentIdRaw);
  const raw = await redis.hget(AUTH_USERS_KEY, studentId);
  if (!raw) return null;
  const record = JSON.parse(raw);
  return { studentId, name: record.name, role: record.role };
}

/**
 * Batch version of getAccountById — one HMGET round trip for N ids instead
 * of N sequential HGETs. Returns an array the SAME length and order as the
 * input, with `null` in place of any id that has no account yet. This is
 * what keeps the day-status dashboard at O(1) Redis round trips as the
 * roster grows into the hundreds.
 */
async function getAccountsByIds(studentIdsRaw) {
  const ids = studentIdsRaw.map((id) => normalizeId(id));
  if (ids.length === 0) return [];
  const raws = await redis.hmget(AUTH_USERS_KEY, ...ids);
  return raws.map((raw, i) => {
    if (!raw) return null;
    const record = JSON.parse(raw);
    return { studentId: ids[i], name: record.name, role: record.role };
  });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws on invalid/expired
}

module.exports = { register, login, verifyToken, getAccountById, getAccountsByIds, bulkProvision };
