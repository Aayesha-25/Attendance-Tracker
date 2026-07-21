const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const router = express.Router();
const authService = require("../lib/authService");
const roster = require("../lib/rosterService");
const { requireAuth, requireRole } = require("../middleware/auth");
const { isValidStudentId, normalizeId } = require("../lib/keys");

// Without this, /login is a free brute-force target — bcrypt(cost 12) slows
// each guess but does not stop a scripted attacker. 10 attempts / 15 min per
// IP+studentId is generous for a real user who fat-fingers a password twice,
// and useless for anyone trying 20 passwords in a row.
// Test suite hammers /login and /register far past any real user's rate in
// seconds flat (29 tests, dozens of accounts, from one IP). Rather than
// weakening the real limit to make tests pass, the limiter is skipped ONLY
// when DISABLE_RATE_LIMIT=true is explicitly set — set that in test runs
// only, never in .env for a real deployment.
const skipInTests = () => process.env.DISABLE_RATE_LIMIT === "true";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.student_id || "").toUpperCase()}`,
  message: { error: "too many login attempts — wait a few minutes and try again" },
});

// Registration is cheaper to abuse in a different way (roster-scraping via
// the 409 vs 403 distinction, or spamming accounts). Keyed by IP+student_id,
// NOT IP-only — this event expects ~200 people registering from the same
// venue WiFi/hotspot in a short window, all sharing one public IP. An
// IP-only limit would lock out person #21 in the same room. Per-identity
// keying means the limit is "how many times can THIS student hammer THIS
// endpoint", which is what actually needs capping.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.student_id || "").toUpperCase()}`,
  message: { error: "too many registration attempts — wait a few minutes and try again" },
});

router.post("/register", registerLimiter, async (req, res, next) => {
  try {
    const { student_id, password, name, admin_code } = req.body;
    if (!student_id || typeof student_id !== "string") {
      return res.status(400).json({ error: "student_id is required" });
    }

    const account = await authService.register(student_id, password, name, admin_code);
    res.status(201).json(account);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { student_id, password } = req.body;
    if (!student_id || !password) return res.status(400).json({ error: "student_id and password are required" });

    const result = await authService.login(student_id, password);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Lets the frontend verify a stored token is still valid and see the
// identity/role attached to it, without needing to decode the JWT client-side.
router.get("/me", requireAuth, (req, res) => {
  res.json({ studentId: req.user.studentId, name: req.user.name, role: req.user.role });
});

// ---- Roster management (admin only) -----------------------------------
// This is how students actually get into "the database" — a coordinator
// adds their college IDs here BEFORE those students can register.
// Without an entry here, /auth/register rejects them with a 403.

router.post("/roster", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { student_ids } = req.body;
    if (!Array.isArray(student_ids) || student_ids.length === 0) {
      return res.status(400).json({ error: "student_ids must be a non-empty array" });
    }

    // Validate format up front so a coordinator gets immediate, specific
    // feedback instead of silently adding a malformed ID that will just
    // fail confusingly at registration time.
    const invalid = student_ids.filter((id) => !isValidStudentId(id));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: "some IDs don't match the expected format (e.g. 25CE113, 25DCE113, D25CE113, D25DCE113)",
        invalid,
      });
    }

    const added = await roster.addToRoster(student_ids);
    const total = await roster.rosterSize();
    res.status(201).json({ added, total });
  } catch (err) {
    next(err);
  }
});

router.get("/roster", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const ids = await roster.listRoster();
    res.json({ count: ids.length, studentIds: ids.sort() });
  } catch (err) {
    next(err);
  }
});

router.delete("/roster", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { student_id } = req.body;
    if (!student_id) return res.status(400).json({ error: "student_id is required" });
    await roster.removeFromRoster(student_id);
    res.json({ removed: normalizeId(student_id) });
  } catch (err) {
    next(err);
  }
});

// ---- Bulk provisioning (admin only) ------------------------------------
// Creates accounts directly, in bulk — this is what replaces the
// self-registration flow for a real event: the coordinator already has
// ID+password pairs assigned offline, and just needs them to exist.
router.post("/bulk-provision", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { entries } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: "entries must be a non-empty array of {student_id, password, name?}" });
    }
    if (entries.length > 1000) {
      return res.status(400).json({ error: "max 1000 entries per request — split into batches" });
    }

    const results = await authService.bulkProvision(entries);
    const created = results.filter((r) => r.ok).length;
    const failed = results.length - created;
    res.status(201).json({ created, failed, results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
