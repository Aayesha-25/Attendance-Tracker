const { verifyToken, getAccountById } = require("../lib/authService");

/**
 * Verifies the Bearer token and attaches the decoded identity to
 * req.user = { studentId, name, role }. Every route that relies on "who
 * is making this request" (checkin, stats, corrections) reads from
 * req.user, NEVER from the request body — the body is attacker-controlled,
 * the verified token is not.
 */
function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "missing or malformed Authorization header (expected: Bearer <token>)" });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    const message = err.name === "TokenExpiredError" ? "token expired, please log in again" : "invalid token";
    return res.status(401).json({ error: message });
  }
}

/**
 * Must run AFTER requireAuth. Restricts a route to a specific role.
 *
 * Deliberately re-reads the role from Redis on every call instead of
 * trusting req.user.role (which came from the JWT payload signed at
 * login time). A JWT is valid for up to JWT_EXPIRES_IN (12h) — if a
 * coordinator is demoted mid-day, their existing token would otherwise
 * keep working as admin for the rest of its 12h life. One extra HGET
 * per admin-gated request is a cheap price for "role never trusted from
 * the token, always from the DB" actually being true, not just a comment.
 */
function requireRole(role) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(500).json({ error: "requireRole used without requireAuth" });
    }
    try {
      const account = await getAccountById(req.user.studentId);
      if (!account || account.role !== role) {
        return res.status(403).json({ error: `requires ${role} role` });
      }
      req.user.role = account.role; // keep req.user in sync with the source of truth
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAuth, requireRole };
