const crypto = require('crypto');
const { loadConfig } = require('./config');

const COOKIE_NAME = 'omnishpilot_session';
const DEFAULT_PASSWORD = '0mnis891lo7';
const DEFAULT_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function authConfig() {
  const cfg = loadConfig();
  const enabled = cfg.auth?.enabled !== false;
  const password = process.env.OMNISHPILOT_PASSWORD || cfg.auth?.password || DEFAULT_PASSWORD;
  const secret = process.env.OMNISHPILOT_SESSION_SECRET
    || cfg.auth?.sessionSecret
    || crypto.createHash('sha256').update(`omnishpilot-session:${password}`).digest('hex');
  const sessionMs = Number(cfg.auth?.sessionMs) || DEFAULT_SESSION_MS;
  return { enabled, password, secret, sessionMs, cfg };
}

function shouldUseSecureCookie(req) {
  const { cfg } = authConfig();
  if (cfg.auth?.secureCookie === false) return false;
  if (cfg.auth?.secureCookie === true) return true;
  if (req?.secure) return true;
  const proto = req?.headers?.['x-forwarded-proto'];
  if (proto === 'https') return true;
  return false;
}

function createSessionToken(secret, sessionMs) {
  const exp = Date.now() + sessionMs;
  const payload = JSON.stringify({ exp, v: 1 });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  } catch {
    return false;
  }
  try {
    const data = JSON.parse(payload);
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function getSessionToken(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

function isAuthenticated(req) {
  const { enabled, secret } = authConfig();
  if (!enabled) return true;
  return verifySessionToken(getSessionToken(req), secret);
}

function setSessionCookie(res, token, req) {
  const { sessionMs } = authConfig();
  const maxAge = Math.floor(sessionMs / 1000);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (shouldUseSecureCookie(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, req) {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (shouldUseSecureCookie(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function verifyPassword(candidate) {
  const { password } = authConfig();
  if (typeof candidate !== 'string' || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(password);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized', loginUrl: '/login.html' });
  }
  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login.html?next=${nextUrl}`);
}

function isPublicPath(reqPath) {
  return reqPath === '/login.html';
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_PASSWORD,
  authConfig,
  createSessionToken,
  verifySessionToken,
  isAuthenticated,
  verifyPassword,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  isPublicPath,
};
