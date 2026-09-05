const crypto = require('node:crypto');

// Two fixed accounts (username is the role name), not per-operator — matches
// the "one shared studio credential, like admin already had" decision.
// Sessions are in-memory only: losing them on a restart just means
// everyone logs in again, unlike the Links registry (Stage 2+) which has
// to survive a restart.
const ROLE_RANK = { studio: 1, admin: 2 };

// Enforced wherever a password is set or changed (see server/index.js's
// POST /api/admin/password) — length plus one of each character class,
// rather than just length, since these are two small shared accounts
// (not per-operator) worth holding to a real bar.
const PASSWORD_MIN_LENGTH = 12;

function passwordComplexityError(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter.';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must include a number.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a symbol.';
  return null;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt') return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const candidate = crypto.scryptSync(password, salt, expected.length);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function createAuth({ studioPasswordHash, adminPasswordHash, sessionHours }) {
  // Mutable (not const-captured) so setPasswordHash can update a hash
  // in place and have it take effect on the very next login — changing a
  // password doesn't touch existing sessions (see setPasswordHash), just
  // future ones.
  const hashes = { studio: studioPasswordHash, admin: adminPasswordHash };
  const sessions = new Map(); // token -> { role, expiresAt }
  const sessionMs = sessionHours * 60 * 60 * 1000;

  function login(username, password) {
    if (username === 'studio' && verifyPassword(password, hashes.studio)) return 'studio';
    if (username === 'admin' && verifyPassword(password, hashes.admin)) return 'admin';
    return null;
  }

  // Takes effect immediately for future logins. Deliberately does not
  // touch existing sessions for that role — an operator mid-broadcast
  // shouldn't be logged out just because an admin changed a password.
  function setPasswordHash(role, hash) {
    hashes[role] = hash;
  }

  function createSession(role) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { role, expiresAt: Date.now() + sessionMs });
    return token;
  }

  function getSession(token) {
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      sessions.delete(token);
      return null;
    }
    return session;
  }

  function destroySession(token) {
    sessions.delete(token);
  }

  setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (now > session.expiresAt) sessions.delete(token);
    }
  }, 60 * 60 * 1000).unref();

  return { login, createSession, getSession, destroySession, setPasswordHash };
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

module.exports = {
  ROLE_RANK,
  passwordComplexityError,
  hashPassword,
  verifyPassword,
  createAuth,
  parseCookies,
};
