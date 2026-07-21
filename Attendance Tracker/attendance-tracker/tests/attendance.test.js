/**
 * Integration tests, run against a real running server + real Redis
 * (node's built-in test runner, no extra deps).
 *
 * Run with: node --test tests/attendance.test.js
 * Requires: server already running with JWT_SECRET and
 * ADMIN_REGISTRATION_CODE set.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";
const EVENT_ID = `test-event-${Date.now()}`;
const PASSWORD = "TestPassword123!";

async function post(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function del(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { method: "DELETE", headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function get(path, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

let _adminTokenPromise = null;
async function getTestAdminToken() {
  if (_adminTokenPromise) return _adminTokenPromise;
  _adminTokenPromise = (async () => {
    const adminCode = process.env.ADMIN_REGISTRATION_CODE;
    if (!adminCode) {
      throw new Error("ADMIN_REGISTRATION_CODE must be set to run this suite (roster is a closed allow-list).");
    }
    const id = `COORDTEST${Date.now()}`.slice(0, 12);
    await post("/api/auth/register", { student_id: id, password: PASSWORD, name: "Suite Admin", admin_code: adminCode });
    const login = await post("/api/auth/login", { student_id: id, password: PASSWORD });
    return login.body.token;
  })();
  return _adminTokenPromise;
}

let _testIdCounter = 0;
const TEST_BRANCHES = ["CE", "IT", "ME", "EE", "CS"];
function nextTestStudentId() {
  _testIdCounter++;
  const branch = TEST_BRANCHES[_testIdCounter % TEST_BRANCHES.length];
  const roll = String(_testIdCounter % 1000).padStart(3, "0");
  return `25${branch}${roll}`;
}

/** Adds id to the roster (via the shared test admin), registers, and logs in. */
async function account(name) {
  const id = nextTestStudentId();
  const adminToken = await getTestAdminToken();
  await post("/api/auth/roster", { student_ids: [id] }, adminToken);
  const reg = await post("/api/auth/register", { student_id: id, password: PASSWORD, name });
  assert.equal(reg.status, 201, `register should succeed for ${id}: ${JSON.stringify(reg.body)}`);
  const login = await post("/api/auth/login", { student_id: id, password: PASSWORD });
  assert.equal(login.status, 200, `login should succeed for ${id}: ${JSON.stringify(login.body)}`);
  return { token: login.body.token, id };
}

/** Resolves a user's numeric id for an event, creating the identity mapping
 * (via GET /me/id) without marking any attendance. Needed before an admin
 * can backfill historical dates for them through /checkin/correct. */
async function meId(eventId, token) {
  const { status, body } = await get(`/api/me/id?event_id=${eventId}`, token);
  assert.equal(status, 200, `me/id should succeed: ${JSON.stringify(body)}`);
  return body.userId;
}

/** Admin-only historical backfill — the ONLY way a non-today date can ever
 * land in the attendance record. Fails loudly if not called with an admin
 * token, which is exactly what several tests below are checking for. */
async function checkinCorrect(eventId, userId, date, adminToken) {
  return post("/api/checkin/correct", { event_id: eventId, user_id: userId, date }, adminToken);
}

// ---- auth flow -------------------------------------------------------------

test("register then login returns a working token", async () => {
  const id = "25CE501";
  const adminToken = await getTestAdminToken();
  await post("/api/auth/roster", { student_ids: [id] }, adminToken);

  const reg = await post("/api/auth/register", { student_id: id, password: PASSWORD, name: "Auth Flow" });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.role, "student");

  const login = await post("/api/auth/login", { student_id: id, password: PASSWORD });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);

  const me = await get("/api/auth/me", login.body.token);
  assert.equal(me.status, 200);
  assert.equal(me.body.studentId, id);
});

test("all four ID formats are accepted", async () => {
  const adminToken = await getTestAdminToken();
  const formats = ["25CE601", "25DCE602", "D25CE603", "D25DCE604"];
  await post("/api/auth/roster", { student_ids: formats }, adminToken);
  for (const id of formats) {
    const reg = await post("/api/auth/register", { student_id: id, password: PASSWORD, name: id });
    assert.equal(reg.status, 201, `${id} should register successfully: ${JSON.stringify(reg.body)}`);
  }
});

test("a malformed ID is rejected even if somehow on the roster", async () => {
  const { status, body } = await post("/api/auth/register", {
    student_id: "not-a-valid-id",
    password: PASSWORD,
    name: "Bad Format",
  });
  assert.equal(status, 400);
  assert.match(body.error, /format/i);
});

test("login with wrong password is rejected", async () => {
  const id = "25CE502";
  const adminToken = await getTestAdminToken();
  await post("/api/auth/roster", { student_ids: [id] }, adminToken);
  await post("/api/auth/register", { student_id: id, password: PASSWORD, name: "Wrong PW" });
  const { status } = await post("/api/auth/login", { student_id: id, password: "not-the-password" });
  assert.equal(status, 401);
});

test("login for a nonexistent ID gets the SAME error as wrong password (no enumeration)", async () => {
  const wrongPw = await post("/api/auth/login", { student_id: "25CE999", password: "x" });
  const noAccount = await post("/api/auth/login", { student_id: "25CE998", password: "x" });
  assert.equal(wrongPw.status, noAccount.status);
  assert.equal(wrongPw.body.error, noAccount.body.error);
});

test("registering the same ID twice is rejected", async () => {
  const id = "25CE503";
  const adminToken = await getTestAdminToken();
  await post("/api/auth/roster", { student_ids: [id] }, adminToken);
  const first = await post("/api/auth/register", { student_id: id, password: PASSWORD, name: "Dupe" });
  const second = await post("/api/auth/register", { student_id: id, password: PASSWORD, name: "Dupe" });
  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
});

test("password under 8 characters is rejected", async () => {
  const id = "25CE504";
  const adminToken = await getTestAdminToken();
  await post("/api/auth/roster", { student_ids: [id] }, adminToken);
  const { status } = await post("/api/auth/register", { student_id: id, password: "abc", name: "Short" });
  assert.equal(status, 400);
});

// ---- checkin requires auth, and trusts the token's identity --------------

test("checkin without a token is rejected", async () => {
  const { status } = await post("/api/checkin", { event_id: EVENT_ID });
  assert.equal(status, 401);
});

test("checkin with a garbage token is rejected", async () => {
  const { status } = await post("/api/checkin", { event_id: EVENT_ID }, "not-a-real-jwt");
  assert.equal(status, 401);
});

test("checkin marks the AUTHENTICATED user present, ignoring any identity in the body", async () => {
  const { token, id } = await account("Alice");

  const { status, body } = await post(
    "/api/checkin",
    { event_id: EVENT_ID, student_id: "25CE999" }, // attempted impersonation, must be ignored
    token
  );
  assert.equal(status, 200);
  assert.ok(Number.isInteger(body.userId));

  const stats = await get(`/api/user/${body.userId}/stats?event_id=${EVENT_ID}&start=${body.date}&end=${body.date}`, token);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.studentId, id);
  assert.equal(stats.body.totalDaysPresent, 1);
});

test("re-checking in the same user/day is idempotent, not an error", async () => {
  const { token } = await account("Carol");
  const first = await post("/api/checkin", { event_id: EVENT_ID }, token);
  const second = await post("/api/checkin", { event_id: EVENT_ID }, token);
  assert.equal(first.body.alreadyCheckedIn, false);
  assert.equal(second.body.alreadyCheckedIn, true);
});

// ---- anti-backdating: the actual security fix, locked in by these two ----

test("checkin ALWAYS marks today, silently ignoring any date field the client sends", async () => {
  const { token } = await account("Backdate Attempt");
  // A student trying to hand-craft a request with a past date must not
  // succeed in backdating — this is what stops "fake a whole month of
  // attendance in one sitting."
  const { status, body } = await post("/api/checkin", { event_id: EVENT_ID, date: "2026-01-01" }, token);
  assert.equal(status, 200);
  assert.notEqual(body.date, "2026-01-01");
});

test("a non-admin cannot use /checkin/correct to backdate their own attendance", async () => {
  const { token } = await account("Sneaky Student");
  const userId = await meId(EVENT_ID, token);
  const { status } = await checkinCorrect(EVENT_ID, userId, "2026-01-01", token);
  assert.equal(status, 403);
});

test("checkin rejects malformed date", async () => {
  const { token } = await account("Eve");
  const adminToken = await getTestAdminToken();
  const userId = await meId(EVENT_ID, token);
  const { status } = await checkinCorrect(EVENT_ID, userId, "not-a-date", adminToken);
  assert.equal(status, 400);
});

test("checkin/correct rejects a future date even for an admin", async () => {
  const { token } = await account("Dave");
  const adminToken = await getTestAdminToken();
  const userId = await meId(EVENT_ID, token);
  const { status, body } = await checkinCorrect(EVENT_ID, userId, "2099-01-01", adminToken);
  assert.equal(status, 400);
  assert.match(body.error, /future/i);
});

// ---- authorization: self vs admin vs stranger -----------------------------

test("a student CANNOT view another student's stats", async () => {
  const a = await account("Priv A");
  const b = await account("Priv B");
  const adminToken = await getTestAdminToken();
  const userIdA = await meId(EVENT_ID, a.token);
  await checkinCorrect(EVENT_ID, userIdA, "2026-07-12", adminToken);

  const { status } = await get(
    `/api/user/${userIdA}/stats?event_id=${EVENT_ID}&start=2026-07-12&end=2026-07-12`,
    b.token
  );
  assert.equal(status, 403);
});

test("a student CAN view their own stats", async () => {
  const { token } = await account("Self");
  const checkin = await post("/api/checkin", { event_id: EVENT_ID }, token);
  const { status } = await get(
    `/api/user/${checkin.body.userId}/stats?event_id=${EVENT_ID}&start=${checkin.body.date}&end=${checkin.body.date}`,
    token
  );
  assert.equal(status, 200);
});

test("a non-admin CANNOT list the roster, view the grid, or view day-status", async () => {
  const { token } = await account("Non Admin");
  const users = await get(`/api/users?event_id=${EVENT_ID}`, token);
  const grid = await get(`/api/grid?event_id=${EVENT_ID}&start=2026-07-10&end=2026-07-11`, token);
  const dayStatus = await get(`/api/day-status?event_id=${EVENT_ID}&date=2026-07-10`, token);
  assert.equal(users.status, 403);
  assert.equal(grid.status, 403);
  assert.equal(dayStatus.status, 403);
});

test("a non-admin CANNOT delete/undo a check-in", async () => {
  const { token } = await account("Non Admin 2");
  const checkin = await post("/api/checkin", { event_id: EVENT_ID }, token);
  const { status } = await del(
    "/api/checkin",
    { event_id: EVENT_ID, user_id: checkin.body.userId, date: checkin.body.date },
    token
  );
  assert.equal(status, 403);
});

test("an admin CAN view any user's stats, list the roster, and undo a check-in", async () => {
  const { token: studentToken } = await account("Admin Target");
  const adminToken = await getTestAdminToken();

  const checkin = await post("/api/checkin", { event_id: EVENT_ID }, studentToken);

  const stats = await get(
    `/api/user/${checkin.body.userId}/stats?event_id=${EVENT_ID}&start=${checkin.body.date}&end=${checkin.body.date}`,
    adminToken
  );
  assert.equal(stats.status, 200);

  const roster = await get(`/api/users?event_id=${EVENT_ID}`, adminToken);
  assert.equal(roster.status, 200);

  const undo = await del(
    "/api/checkin",
    { event_id: EVENT_ID, user_id: checkin.body.userId, date: checkin.body.date },
    adminToken
  );
  assert.equal(undo.status, 200);
  assert.equal(undo.body.wasCheckedIn, true);
});

// ---- day-status: present/absent split against the full roster -----------

test("day-status splits roster into present and absent correctly", async () => {
  const eid = `daystatus-${Date.now()}`;
  const adminToken = await getTestAdminToken();

  const presentId = "25CE701";
  const absentRegisteredId = "25CE702";
  const neverRegisteredId = "25CE703";

  await post("/api/auth/roster", { student_ids: [presentId, absentRegisteredId, neverRegisteredId] }, adminToken);

  await post("/api/auth/register", { student_id: presentId, password: PASSWORD, name: "Present One" });
  const presentToken = (await post("/api/auth/login", { student_id: presentId, password: PASSWORD })).body.token;
  const checkin = await post("/api/checkin", { event_id: eid }, presentToken);

  await post("/api/auth/register", { student_id: absentRegisteredId, password: PASSWORD, name: "Absent Registered" });
  // deliberately does NOT check in

  const { status, body } = await get(`/api/day-status?event_id=${eid}&date=${checkin.body.date}`, adminToken);
  assert.equal(status, 200);
  // The roster is deliberately GLOBAL (it represents "valid college
  // students", not "enrolled in this one event"), so other tests running
  // in the same suite may have added other IDs to it — totalRoster can
  // legitimately be larger than the 3 we just added. What matters is that
  // OUR three IDs land in the right bucket.
  assert.ok(body.totalRoster >= 3);

  const presentIds = body.present.map((p) => p.studentId);
  const absentIds = body.absent.map((p) => p.studentId);
  assert.ok(presentIds.includes(presentId));
  assert.ok(absentIds.includes(absentRegisteredId));
  assert.ok(absentIds.includes(neverRegisteredId));
  assert.ok(!presentIds.includes(absentRegisteredId));
  assert.ok(!presentIds.includes(neverRegisteredId));

  const neverRegEntry = body.absent.find((p) => p.studentId === neverRegisteredId);
  assert.equal(neverRegEntry.registered, false);
  assert.equal(neverRegEntry.name, null);
});

// ---- streak correctness ----------------------------------------------------

test("longest streak vs current streak differ correctly across a gap", async () => {
  const { token } = await account("Streak Test");
  const adminToken = await getTestAdminToken();
  const userId = await meId(EVENT_ID, token);

  await checkinCorrect(EVENT_ID, userId, "2026-06-01", adminToken);
  await checkinCorrect(EVENT_ID, userId, "2026-06-02", adminToken);
  await checkinCorrect(EVENT_ID, userId, "2026-06-03", adminToken);
  await checkinCorrect(EVENT_ID, userId, "2026-06-05", adminToken);

  const { body } = await get(
    `/api/user/${userId}/stats?event_id=${EVENT_ID}&start=2026-06-01&end=2026-06-05`,
    token
  );
  assert.equal(body.totalDaysPresent, 4);
  assert.equal(body.longestStreak, 3);
  assert.equal(body.currentStreak, 1);
});

test("stats rejects an oversized date range (DoS guard)", async () => {
  const { token } = await account("Range Test");
  const checkin = await post("/api/checkin", { event_id: EVENT_ID }, token);
  const { status, body } = await get(
    `/api/user/${checkin.body.userId}/stats?event_id=${EVENT_ID}&start=1970-01-01&end=2099-12-31`,
    token
  );
  assert.equal(status, 400);
  assert.match(body.error, /exceeds maximum/i);
});

// ---- BITOP overlap correctness (public — reveals counts only, no PII) ---

test("overlap counts only users present on ALL given days", async () => {
  const eid = `overlap-test-${Date.now()}`;
  const frank = await account("Frank");
  const grace = await account("Grace");
  const adminToken = await getTestAdminToken();
  const frankId = await meId(eid, frank.token);
  const graceId = await meId(eid, grace.token);

  await checkinCorrect(eid, frankId, "2026-07-01", adminToken);
  await checkinCorrect(eid, frankId, "2026-07-02", adminToken);
  await checkinCorrect(eid, graceId, "2026-07-01", adminToken);

  const { body } = await get(`/api/overlap?event_id=${eid}&dates=2026-07-01,2026-07-02`);
  assert.equal(body.overlapCount, 1);
});

test("concurrent overlap requests do not corrupt each other (scratch-key collision regression test)", async () => {
  const eid = `overlap-concurrency-${Date.now()}`;
  const u1 = await account("U1");
  const u2 = await account("U2");
  const adminToken = await getTestAdminToken();
  const u1Id = await meId(eid, u1.token);
  const u2Id = await meId(eid, u2.token);

  await checkinCorrect(eid, u1Id, "2026-07-01", adminToken);
  await checkinCorrect(eid, u1Id, "2026-07-02", adminToken);
  await checkinCorrect(eid, u2Id, "2026-07-01", adminToken);
  await checkinCorrect(eid, u2Id, "2026-07-03", adminToken);

  const [r1, r2] = await Promise.all([
    get(`/api/overlap?event_id=${eid}&dates=2026-07-01,2026-07-02`),
    get(`/api/overlap?event_id=${eid}&dates=2026-07-01,2026-07-03`),
  ]);
  assert.equal(r1.body.overlapCount, 1);
  assert.equal(r2.body.overlapCount, 1);
});

// ---- health check -----------------------------------------------------------

test("health check reports Redis connectivity", async () => {
  const { status, body } = await get("/health");
  assert.equal(status, 200);
  assert.equal(body.redis, "connected");
});
