# Attendance Bitmap Tracker

Multi-day attendance tracking for a live event (built for **Binary Battles
2026**, ~200 registrants), on **Redis Bitmaps** — `SETBIT` / `GETBIT` /
`BITCOUNT` / `BITOP`. One bit per user per day answers "who's present
today," "what's their longest streak," and "who attended day 3 AND day 5"
without ever scanning rows.

Verified end-to-end for this README: `npm test` → **29/29 passing**, plus
manual attack/load testing described under [Security](#security-posture)
and [Load characteristics](#load-characteristics-measured).

---

## Why bitmaps, not a table or a Set

One key per **day**, one **bit per user** (offset = that user's numeric id):

```
attendance:{eventId}:day:{YYYY-MM-DD}   →  bitmap
```

| Operation | With bitmaps | With a naive table/Set |
|---|---|---|
| Today's total attendance | `BITCOUNT` — one key, one round trip | `COUNT(*)` / `SCARD`, scans rows |
| "Present on day 3 AND day 5" | `BITOP AND` computed **inside Redis**, then `BITCOUNT` | Pull both sets into app code, intersect manually |
| Storage for 200 users × 30 days | Well under a KB per day key | Tens of KB+ — one row/member per check-in |

**Honest limitation:** Redis has no native "longest run of set bits."
`BITCOUNT` gives totals, `BITOP` gives intersections — neither gives
streaks. Streak calculation happens in application code: one pipelined
batch of `GETBIT` calls across the date range (a single Redis round trip,
not one call per day), then a single pass to find the longest consecutive
run. See `src/lib/attendanceService.js:getUserStats`. This is a deliberate
design choice, not a workaround.

---

## Architecture

```
┌──────────────┐      ┌────────────────────┐      ┌────────────┐
│  frontend/    │─────▶│  Express API        │─────▶│  Redis 7    │
│  index.html   │◀─────│  (ioredis client)   │◀─────│  (bitmaps)  │
└──────────────┘      └────────────────────┘      └────────────┘
      served                 src/server.js               AOF-persisted,
   same-origin,          src/routes/*.js                 named volume
   no separate host      src/lib/*.js
                         src/middleware/auth.js
```

| File | Responsibility |
|---|---|
| `src/server.js` | Entrypoint — helmet, CORS, request log, `/health`, graceful shutdown |
| `src/routes/auth.js` | Login, roster management, bulk account provisioning, rate limiting |
| `src/routes/attendance.js` | Check-in, undo, stats, day-status, overlap, grid |
| `src/lib/attendanceService.js` | All Redis bitmap logic — the actual product |
| `src/lib/authService.js` | Password hashing, JWT issuance, account storage, bulk provisioning |
| `src/lib/adminOverviewService.js` | Coordinator's present/absent dashboard query (pipelined) |
| `src/lib/userIdentity.js` | Maps a student ID → the numeric id a bitmap offset requires |
| `src/lib/rosterService.js` | The closed allow-list backing self-registration (kept for the test suite / edge cases; not exposed in the UI) |
| `src/lib/keys.js` | Single source of truth for the Redis key schema, ID format, date/timezone logic |
| `src/middleware/auth.js` | JWT verification + admin-role re-check (see below) |
| `scripts/seed.js` | Demo data generator (perfect streak, broken streak, ~60 random users) |
| `frontend/index.html` | The entire UI — login screen + student/admin views, one static file |
| `tests/*.test.js` | 29 integration tests, run against a live server + live Redis |

---

## Authentication & account provisioning

**The UI is login-only.** There is no register screen, no logo, no event-ID
box for participants to fill in. This matches how the event actually runs:
the coordinator provisions every account **before** the event starts, and
hands each participant their ID + password on paper/screen. Participants
only ever see:

```
ID:       [___________]
Password: [___________]
[ Log in ]
```

### How accounts actually get created

```
POST /api/auth/bulk-provision      (admin only)
Body: { "entries": [ { "student_id": "25CE113", "password": "x7Qz2Kmf", "name": "Aayesha" }, ... ] }
```

- Validates each row independently (ID format, password ≥ 8 chars, no
  duplicate within the same batch) — one bad row doesn't abort the batch.
- Adds each successfully-created ID to the roster automatically.
- Returns per-row results so the coordinator sees exactly what succeeded:
  ```json
  { "created": 2, "failed": 3, "results": [ { "studentId": "25CE002", "ok": false, "error": "duplicate ID within this batch — only the first was used" }, ... ] }
  ```
- Capped at 1000 entries per call — batch a 200-person roster in one request, no problem.

The old self-service `POST /api/auth/register` endpoint (roster-gated,
rate-limited) is still in the codebase and still covered by tests — it's
what the automated test suite uses to set up fixtures, and it's a
reasonable fallback if you ever need someone to self-serve. It's simply
not wired into the frontend anymore.

### Login

`POST /api/auth/login` → `{ token, studentId, name, role }`. Wrong password
and unknown ID return the **identical** error/status (`401`, "invalid ID
or password") — this is deliberate, so login can't be used to enumerate
which IDs have registered accounts.

### Authorization model

| Endpoint | Who can call it |
|---|---|
| `POST /api/checkin` | Any authenticated user — checks **themselves** in only (identity comes from the verified JWT, never the request body) |
| `GET /api/user/:id/stats` | That user, or an admin |
| `GET /api/users`, `/api/grid`, `/api/day-status` | Admin only |
| `DELETE /api/checkin` | Admin only (undoes a mistaken check-in) |
| `POST/GET/DELETE /api/auth/roster`, `POST /api/auth/bulk-provision` | Admin only |
| `GET /api/overlap`, `GET /api/day/:date/count` | Public — counts only, no PII |

**Role is never trusted from the token alone.** `requireRole('admin')`
re-reads the account's current role from Redis on every admin-gated
request instead of trusting the role baked into the JWT at login time. A
JWT is valid for up to 12h — without this re-check, demoting a coordinator
mid-event would leave their old token working as admin for the rest of
its life. Verified: demoted an admin's DB record mid-session and the same
still-unexpired token got `403` on the very next request.

---

## Security posture

Everything below was attacked, not just written — see the exact repro
commands in the project history; summarized here:

| Risk | Mitigation | How it was verified |
|---|---|---|
| Stored XSS via `name` field | Server strips `<>&"'` before persisting (`authService.sanitizeName`) + frontend escapes on render | Registered `name="<img src=x onerror=...>"` — came back as inert text, no markup characters survive |
| Brute-force login | `express-rate-limit`, 10 attempts / 15 min, keyed by IP **+ student ID** | 11th attempt in the window returned `429` |
| Registration abuse at scale | 8 attempts / 15 min, keyed by IP + student ID (**not IP-only** — ~200 people on one venue WiFi share an IP; an IP-only limit would lock the whole room out after person #8) | — |
| Stale-privilege tokens | `requireRole` re-checks Redis on every call, not the JWT claim | See "role re-check" above |
| Generic HTTP hardening | `helmet()` — CSP, HSTS, `X-Powered-By` removed | `curl -I /health` shows no `X-Powered-By`, CSP/HSTS present |
| IDOR on stats | `/api/user/:id/stats` checks `profile.studentId === req.user.studentId \|\| role === 'admin'` | Second student's token against the first student's numeric ID → `403` |
| Password storage | `bcrypt`, cost factor 10 (see load-testing note below for why not 12) | — |
| Enumeration via login errors | Wrong password and unknown ID return the same error/status | — |

**Known, accepted trade-off:** `helmet`'s CSP allows
`script-src 'unsafe-inline'` because `frontend/index.html` uses inline
`onclick=` handlers rather than a separate JS file with
`addEventListener`. A strict CSP would normally be the main defense
against stored XSS reaching execution — here that defense is redundant
with (and secondary to) `sanitizeName()` stripping markup characters
server-side before user text is ever persisted. Documented in
`src/server.js`, not a silent gap.

**Not done — real gaps for anything beyond this event:** no token
revocation/blocklist (a leaked token is valid until it expires), no TLS
termination (put nginx/Caddy in front for anything internet-facing), no
audit log of admin actions (undo/roster edits aren't attributed anywhere
but Redis's raw state), CORS currently allows any origin. Fine for a
single-event, single-admin, LAN-or-campus-network deployment. Not fine to
copy-paste into a multi-tenant SaaS without addressing these first.

---

## Load characteristics (measured)

Actual numbers from running this exact code against a fresh Redis instance:

| Operation | Measured | Notes |
|---|---|---|
| Add 200 IDs to roster | 0.04s | Single `SADD` |
| Admin day-status dashboard, 200-person roster | **31ms** | 3 fixed Redis round trips (roster `SMEMBERS`, idmap `HGETALL`, one `HMGET` for all 200 accounts) — does **not** scale with roster size |
| 200 checkins | 0.41s | No bcrypt involved |
| 200 sequential register+login, bcrypt cost 12 | 143s (~0.7s/account) | Original cost factor — too slow for a 200-person registration burst |
| Same, bcrypt cost 10 | ~35s total, full test suite time dropped 20.9s → 5.8s | **Why cost 10 was chosen**: `bcryptjs` hashes on Node's single main thread (no worker-pool offload, unlike the native `bcrypt` module) — every concurrent request queues behind it. Cost 10 is still a real, adequate lock for a college attendance system; cost 12 turns a 200-person kickoff-moment registration burst into a multi-minute queue where the last person in line waits behind everyone else's hashing work. |

**Practical implication:** since accounts are now bulk-provisioned ahead
of time (not self-registered at kickoff), this bottleneck barely matters
anymore — the expensive bcrypt work happens once, offline, before the
event starts, not in a live 200-person burst. It's documented here because
the trade-off is real and deliberate, not because it's still the
top operational risk.

---

## Redis key schema

```
attendance:{eventId}:day:{YYYY-MM-DD}   bitmap,  offset = numeric userId
users:{eventId}                         hash,    userId -> JSON({studentId,name})
idmap:{eventId}                         hash,    STUDENT_ID -> numeric userId
idcounter:{eventId}                     int,     auto-increment counter
overlap:tmp:{eventId}:{requestId}       bitmap,  scratch key for BITOP, 30s TTL
auth:users                              hash,    STUDENT_ID -> JSON({passwordHash,name,role,createdAt})
roster:allowed_ids                      set,     normalized (uppercase) allow-listed IDs
```

ID format (roster + registration + bulk-provision, enforced by regex):
`25CE113` · `25DCE113` · `D25CE113` · `D25DCE113` — optional single-letter
prefix, 2-digit year, 2–3 letter branch code, 3-digit roll number.

---

## API reference

All endpoints under `/api`. `event_id` is required on every read/write
endpoint so one deployment can serve multiple concurrent events.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/bulk-provision` | Bearer + admin | Create up to 1000 accounts at once with pre-assigned passwords |
| POST | `/api/auth/register` | — (rate-limited) | Self-service registration; roster-gated. Kept for tests/fallback, not in the UI |
| POST | `/api/auth/login` | — (rate-limited) | `{student_id, password}` → `{token, studentId, name, role}` |
| GET | `/api/auth/me` | Bearer | Verify current identity |
| POST/GET/DELETE | `/api/auth/roster` | Bearer + admin | Manage the closed allow-list |
| POST | `/api/checkin` | Bearer | `{event_id, date?}` → marks present. Idempotent, rejects future dates |
| DELETE | `/api/checkin` | Bearer + admin | `{event_id, user_id, date}` → undo a check-in |
| GET | `/api/day-status?event_id=&date=` | Bearer + admin | Full roster split present/absent — the coordinator's default view |
| GET | `/api/day/:date/count?event_id=` | — | Total present that day (`BITCOUNT`) |
| GET | `/api/user/:userId/stats?event_id=&start=&end=` | Bearer (self or admin) | Days present, longest streak, current streak |
| GET | `/api/overlap?event_id=&dates=d1,d2,d3` | — | Users present on ALL listed days (`BITOP AND`) |
| GET | `/api/grid?event_id=&start=&end=` | Bearer + admin | Full user × day matrix for the heatmap UI |
| GET | `/api/users?event_id=` | Bearer + admin | List all known users for an event |
| GET | `/api/me/id?event_id=` | Bearer | Resolve your own numeric userId (no attendance side effect) |
| GET | `/health` | — | Liveness + actual Redis ping (returns `503` if Redis is unreachable, never a false-positive `200`) |

---

## Running it

```bash
cp .env.example .env
```

Edit `.env` — `JWT_SECRET` and `ADMIN_REGISTRATION_CODE` are **required**;
the server refuses to start without them (fails loud, not silently
insecure).

```bash
docker compose up --build
```

App: `http://localhost:4000`. Redis runs with `appendonly yes` on a named
volume, so attendance data survives a container restart.

**First-time setup**, once containers are healthy:

```bash
# 1. Register the coordinator account (one-time, via curl or Postman —
#    there's no UI for this on purpose):
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"student_id":"COORD1","password":"<a real password>","name":"Coordinator","admin_code":"<your ADMIN_REGISTRATION_CODE>"}'

# 2. Log in to get an admin token, then bulk-provision the real roster:
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"student_id":"COORD1","password":"<a real password>"}'

curl -X POST http://localhost:4000/api/auth/bulk-provision \
  -H "Content-Type: application/json" -H "Authorization: Bearer <admin token>" \
  -d '{"entries":[{"student_id":"25CE001","password":"<assigned password>","name":"..."}, ...]}'
```

Hand out the assigned ID + password pairs; participants only ever open the
login screen.

For demo/seed data instead of real provisioning:
```bash
docker compose exec app node scripts/seed.js
```

---

## Testing

```bash
npm test
```

29 integration tests, run against a **live server + live Redis** — not
mocks. Covers: format validation, login enumeration resistance, IDOR
checks (a student cannot view another student's stats or list the
roster), race-condition regressions (concurrent `/overlap` requests don't
corrupt each other's scratch key), DoS guards (oversized date ranges
rejected), streak-vs-current-streak edge cases, and full admin-vs-student
authorization boundaries.

The test suite hits `/auth/login` and `/auth/register` far faster than
rate limiting allows for a real user. Rather than weakening the real
limiter, tests run with an explicit opt-out:

```bash
DISABLE_RATE_LIMIT=true ADMIN_REGISTRATION_CODE=<your test code> npm test
```

**Never set `DISABLE_RATE_LIMIT` in a real `.env`.**

---

## Production details that matter for a real deployment

- **Persistence** — Redis AOF (`appendonly yes`) on a named Docker volume; a
  `docker compose down && up` doesn't lose attendance data.
- **Connection resilience** — `ioredis` retries with capped exponential
  backoff instead of crash-looping if the app container starts before
  Redis is ready.
- **Concurrency safety** — first-time user-id assignment uses atomic
  `INCR` + `HSETNX` so two people's first check-in at the exact same
  instant never collide on the same numeric id.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` let in-flight requests finish
  and close the Redis connection deliberately, instead of dropping
  requests on a redeploy.
- **Multi-tenant by design** — every key is namespaced by `event_id`; one
  deployment can serve more than one event.
