const test = require("node:test");
const assert = require("node:assert/strict");

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";
const PASSWORD = "TestPassword123!";
const ADMIN_CODE = process.env.ADMIN_REGISTRATION_CODE;

async function post(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test("registration is rejected for an ID NOT on the roster", async () => {
  const { status, body } = await post("/api/auth/register", { student_id: "25CE801", password: PASSWORD, name: "Nobody" });
  assert.equal(status, 403);
  assert.match(body.error, /roster/i);
});

test("admin can add a student to the roster, then that student can register", async (t) => {
  if (!ADMIN_CODE) { t.skip("ADMIN_REGISTRATION_CODE not set in test env"); return; }

  const adminId = `COORDA${Date.now()}`.slice(0, 12);
  await post("/api/auth/register", { student_id: adminId, password: PASSWORD, name: "Admin", admin_code: ADMIN_CODE });
  const adminToken = (await post("/api/auth/login", { student_id: adminId, password: PASSWORD })).body.token;

  const studentId = "25CE802";

  const before = await post("/api/auth/register", { student_id: studentId, password: PASSWORD, name: "Student" });
  assert.equal(before.status, 403);

  const addRes = await post("/api/auth/roster", { student_ids: [studentId] }, adminToken);
  assert.equal(addRes.status, 201);
  assert.equal(addRes.body.added, 1);

  const after = await post("/api/auth/register", { student_id: studentId, password: PASSWORD, name: "Student" });
  assert.equal(after.status, 201);
  assert.equal(after.body.role, "student");
});

test("a non-admin cannot add to the roster", async (t) => {
  if (!ADMIN_CODE) { t.skip("ADMIN_REGISTRATION_CODE not set"); return; }
  const studentId = "25CE803";

  const adminId = `COORDB${Date.now()}`.slice(0, 12);
  await post("/api/auth/register", { student_id: adminId, password: PASSWORD, name: "A", admin_code: ADMIN_CODE });
  const adminToken = (await post("/api/auth/login", { student_id: adminId, password: PASSWORD })).body.token;
  await post("/api/auth/roster", { student_ids: [studentId] }, adminToken);
  await post("/api/auth/register", { student_id: studentId, password: PASSWORD, name: "Student" });
  const studentToken = (await post("/api/auth/login", { student_id: studentId, password: PASSWORD })).body.token;

  const { status } = await post("/api/auth/roster", { student_ids: ["25CE804"] }, studentToken);
  assert.equal(status, 403);
});

test("a wrong admin_code falls through to the roster check, not a bypass", async (t) => {
  if (!ADMIN_CODE) { t.skip("ADMIN_REGISTRATION_CODE not set"); return; }
  const { status, body } = await post("/api/auth/register", {
    student_id: "25CE805", password: PASSWORD, name: "X", admin_code: "definitely-not-the-real-code",
  });
  assert.equal(status, 403);
  assert.match(body.error, /roster/i);
});

test("roster rejects malformed IDs with a specific error before touching anything", async (t) => {
  if (!ADMIN_CODE) { t.skip("ADMIN_REGISTRATION_CODE not set"); return; }
  const adminId = `COORDC${Date.now()}`.slice(0, 12);
  await post("/api/auth/register", { student_id: adminId, password: PASSWORD, name: "A", admin_code: ADMIN_CODE });
  const adminToken = (await post("/api/auth/login", { student_id: adminId, password: PASSWORD })).body.token;

  const { status, body } = await post("/api/auth/roster", { student_ids: ["not-valid", "25CE806"] }, adminToken);
  assert.equal(status, 400);
  assert.ok(body.invalid.includes("not-valid"));
});
