// Accounts and sessions. Passwords are hashed with scrypt; sessions are random
// tokens in an HttpOnly cookie, stored server-side only as a SHA-256 hash.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getDb, nowIso } from './db.js';
import { STORES } from './stores.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'sid';
const SESSION_DAYS = 30;
const SECURE_COOKIES = process.env.SECURE_COOKIES
  ? process.env.SECURE_COOKIES === 'true'
  : process.env.NODE_ENV === 'production';

export const MIN_PASSWORD = 8;

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function publicUser(u) {
  return u && {
    id: u.id, email: u.email, name: u.name, isAdmin: !!u.is_admin,
    preferredStores: parsePreferred(u.preferred_stores),
    igaStoreId: u.iga_store || null,
  };
}

/** The user's chosen shops (all shops if they haven't chosen). */
function parsePreferred(json) {
  try {
    const list = JSON.parse(json || 'null');
    const clean = Array.isArray(list) ? list.filter((s) => STORES.includes(s)) : [];
    return clean.length ? clean : [...STORES];
  } catch {
    return [...STORES];
  }
}

/** @param igaStore  an IGA store id the caller has already validated */
export function updateProfile(userId, { name, preferredStores, igaStore }) {
  const d = getDb();
  if (igaStore != null) d.prepare('UPDATE users SET iga_store = ? WHERE id = ?').run(String(igaStore), userId);
  if (name != null) {
    const n = String(name).trim();
    if (!n || n.length > 80) throw httpError(400, 'Name must be 1–80 characters');
    d.prepare('UPDATE users SET name = ? WHERE id = ?').run(n, userId);
  }
  if (preferredStores != null) {
    const clean = [...new Set((Array.isArray(preferredStores) ? preferredStores : []).filter((s) => STORES.includes(s)))];
    if (!clean.length) throw httpError(400, 'Choose at least one shop');
    d.prepare('UPDATE users SET preferred_stores = ? WHERE id = ?').run(JSON.stringify(clean), userId);
  }
  return publicUser(d.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

async function requirePassword(userId, password) {
  const u = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!u || !(await verifyPassword(String(password || ''), u.password_hash))) throw httpError(400, 'Your current password is wrong');
}

/** Change password and sign out every other session. */
export async function changePassword(userId, currentPassword, newPassword, keepTokenOf) {
  await requirePassword(userId, currentPassword);
  if (String(newPassword || '').length < MIN_PASSWORD) throw httpError(400, `New password must be at least ${MIN_PASSWORD} characters`);
  const d = getDb();
  d.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(newPassword), userId);
  const keep = keepTokenOf ? tokenHash(keepTokenOf) : '';
  d.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keep);
}

/** Delete the account. Lists they own and share with nobody go too; shared ones pass to another member. */
export async function deleteAccount(userId, password) {
  await requirePassword(userId, password);
  const d = getDb();
  d.transaction(() => {
    const owned = d.prepare("SELECT list_id FROM list_members WHERE user_id = ? AND role = 'owner'").all(userId);
    for (const { list_id: listId } of owned) {
      const heir = d.prepare('SELECT user_id FROM list_members WHERE list_id = ? AND user_id != ? ORDER BY joined_at LIMIT 1').get(listId, userId);
      if (heir) d.prepare("UPDATE list_members SET role = 'owner' WHERE list_id = ? AND user_id = ?").run(listId, heir.user_id);
      else d.prepare('DELETE FROM lists WHERE id = ?').run(listId);
    }
    d.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
}

export function sessionToken(req) {
  return readCookie(req, COOKIE);
}

/** Emails listed in ADMIN_EMAILS become admins when they sign up. */
function isConfiguredAdmin(email) {
  return (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
    .includes(email.toLowerCase());
}

export async function createUser({ email, name, password }) {
  email = String(email || '').trim();
  name = String(name || '').trim() || email.split('@')[0];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw httpError(400, 'Enter a valid email address');
  if (String(password || '').length < MIN_PASSWORD) throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  if (name.length > 80) throw httpError(400, 'Name is too long');
  const d = getDb();
  if (d.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw httpError(409, 'An account with that email already exists');
  const hash = await hashPassword(password);
  const id = d.prepare('INSERT INTO users (email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(email, name, hash, isConfiguredAdmin(email) ? 1 : 0, nowIso()).lastInsertRowid;
  return publicUser(d.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

export async function checkLogin(email, password) {
  const u = getDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  // Hash something even for unknown emails so timing doesn't reveal which accounts exist.
  const ok = await verifyPassword(String(password || ''), u?.password_hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
  if (!u || !ok) throw httpError(401, 'Wrong email or password');
  return publicUser(u);
}

export function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  getDb().prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash(token), userId, nowIso(), expires.toISOString());
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES, expires, path: '/' });
}

export function endSession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Express middleware: sets req.user when a valid session cookie is present. */
export function loadUser(req, res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const row = getDb().prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash(token), nowIso());
    req.user = publicUser(row) || null;
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admins only' });
  next();
}

/**
 * Cross-site request forgery guard: state-changing API calls must come from
 * our own pages (same Origin) and be JSON, which a third-party form can't send.
 */
export function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  if (req.headers['content-length'] && req.headers['content-length'] !== '0' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Send JSON' });
  }
  next();
}

/** Small in-memory fixed-window rate limiter (single-process deployments). */
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    if (n > max) return res.status(429).json({ error: 'Too many requests — please wait a minute and try again' });
    next();
  };
}

export function purgeExpiredSessions() {
  getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
}
