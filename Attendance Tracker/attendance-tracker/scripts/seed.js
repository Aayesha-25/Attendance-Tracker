/**
 * Seeds realistic, DEMO-ABLE attendance data by going through the REAL
 * auth flow (roster -> register -> login -> authenticated checkin)
 * rather than poking Redis directly — this doubles as a smoke test that
 * the whole stack works end-to-end together.
 *
 * Requires the server to be RUNNING (this hits HTTP, not Redis directly).
 * Run with: node scripts/seed.js  (or npm run seed)
 */
require("dotenv").config();

const BASE_URL = process.env.SEED_BASE_URL || "http://localhost:4000";
const EVENT_ID = process.env.SEED_EVENT_ID || "binary-battles-2026";
const START_DATE = "2026-07-10";
const END_DATE = "2026-07-16"; // 7-day window
const RANDOM_USER_COUNT = 60;
const SEED_PASSWORD = "SeedPassword123!"; // demo data only, never used for real accounts

function dateRange(startStr, endStr) {
  const out = [];
  let cur = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr + "T00:00:00Z");
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}

// Valid-format student IDs (25 + CE + 3-digit roll), matching the real
// college roll-number shape this system validates against.
function studentId(n) {
  return `25CE${String(n).padStart(3, "0")}`;
}

async function registerAndLogin(id, name, adminCode) {
  await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ student_id: id, password: SEED_PASSWORD, name, admin_code: adminCode }),
  }); // ignore rejection (already exists on a re-run) — see main()

  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ student_id: id, password: SEED_PASSWORD }),
  });
  const { token } = await loginRes.json();
  if (!token) throw new Error(`login failed for ${id} — is the server running with JWT_SECRET set?`);
  return token;
}

async function checkIn(token, date) {
  const res = await fetch(`${BASE_URL}/api/checkin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ event_id: EVENT_ID, date }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`checkin failed: ${JSON.stringify(body)}`);
  return body;
}

async function addRoster(adminToken, studentIds) {
  const res = await fetch(`${BASE_URL}/api/auth/roster`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ student_ids: studentIds }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`roster add failed: ${JSON.stringify(body)}`);
  return body;
}

const PERFECT_ID = studentId(1);
const BROKEN_ID = studentId(2);

async function main() {
  const days = dateRange(START_DATE, END_DATE);
  console.log(`Seeding event "${EVENT_ID}" across ${days.length} days via ${BASE_URL}`);

  const adminCode = process.env.ADMIN_REGISTRATION_CODE;
  if (!adminCode) {
    console.error(
      "ADMIN_REGISTRATION_CODE is not set. The roster is a closed allow-list — " +
        "an admin has to exist and add students before they can register. Set " +
        "ADMIN_REGISTRATION_CODE and re-run."
    );
    process.exit(1);
  }

  // 1. Bootstrap the coordinator account — the only account that can add
  //    students to the roster. Admin logins don't need to match the
  //    student ID format.
  const adminToken = await registerAndLogin("COORD1", "Faculty Coordinator", adminCode);
  console.log(`  admin account ready: COORD1 / ${SEED_PASSWORD}`);

  // 2. Build the full list of student IDs this seed will use, and have
  //    the ADMIN add them to the roster BEFORE any of them try to
  //    register — exactly the order a real coordinator would follow.
  const studentIds = Array.from({ length: RANDOM_USER_COUNT + 2 }, (_, i) => studentId(i + 1));
  const rosterResult = await addRoster(adminToken, studentIds);
  console.log(`  roster: added ${rosterResult.added} new IDs (${rosterResult.total} total on roster)`);

  // 3. NOW students can register — they're on the roster.
  const perfectToken = await registerAndLogin(PERFECT_ID, "Aayesha (Perfect Streak Demo)");
  let perfectUserId;
  for (const d of days) {
    perfectUserId = (await checkIn(perfectToken, d)).userId;
  }
  console.log(`  ${PERFECT_ID} (userId=${perfectUserId}) -> present all ${days.length} days`);

  // Broken-streak user: present, present, GAP, present, present, present, GAP
  const brokenToken = await registerAndLogin(BROKEN_ID, "Broken Streak Demo");
  const brokenPattern = [true, true, false, true, true, true, false];
  let brokenUserId;
  for (let i = 0; i < days.length; i++) {
    if (brokenPattern[i % brokenPattern.length]) {
      brokenUserId = (await checkIn(brokenToken, days[i])).userId;
    }
  }
  console.log(`  ${BROKEN_ID} (userId=${brokenUserId}) -> longest run should be 3, current streak 0`);

  // 4. Random spread of users for realistic day counts + overlap demo.
  // A meaningful chunk are left UNREGISTERED (on the roster, but no
  // account created) — this is what makes the admin's absent list show
  // people who were never even present in the "checked in" system.
  let checkedInCount = 0;
  for (let i = 3; i <= RANDOM_USER_COUNT + 2; i++) {
    const id = studentId(i);
    if (Math.random() < 0.15) continue; // ~15% never register at all — stay "absent, unregistered"
    const token = await registerAndLogin(id, `Student ${id}`);
    checkedInCount++;
    for (const d of days) {
      if (Math.random() < 0.7) await checkIn(token, d); // ~70% attendance per registered day
    }
  }
  console.log(`  seeded ~${checkedInCount} registered students with random attendance (rest left unregistered on purpose)`);

  console.log("\nDone. All seeded student accounts use password:", SEED_PASSWORD);
  console.log("Try:");
  console.log(`  POST ${BASE_URL}/api/auth/login  {"student_id":"${PERFECT_ID}","password":"${SEED_PASSWORD}"}`);
  console.log(`  GET  ${BASE_URL}/api/day-status?event_id=${EVENT_ID}&date=${days[0]}  (as COORD1)`);
  console.log(`  GET  ${BASE_URL}/api/overlap?event_id=${EVENT_ID}&dates=${days[0]},${days[1]},${days[2]}`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
