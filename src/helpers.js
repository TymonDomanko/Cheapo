// Who is collecting prices: this server, the site's own home collector (the
// COLLECTOR_TOKEN in Site settings), and helpers — collectors an admin has
// approved, each with its own token, so they can be named, seen and turned off
// one by one. They share the work; they don't add to how much is asked of a
// shop (see src/coles-live.js and src/sharing.js).

import crypto from 'node:crypto';
import { getDb, nowIso } from './db.js';
import { getSetting, newCollectorToken } from './settings.js';

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

export const SERVER = { id: 'server', name: 'This server' };
const HOME = { id: 'home', name: 'Home collector' };

/** The worker a collector token belongs to, or null. */
export function identify(token) {
  token = String(token || '');
  if (!token) return null;
  const site = getSetting('COLLECTOR_TOKEN');
  if (site && token.length === site.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(site))) return HOME;
  const row = getDb().prepare('SELECT id, name FROM collectors WHERE token_hash = ? AND disabled = 0').get(hash(token));
  return row ? { id: `h${row.id}`, name: row.name, helperId: row.id } : null;
}

/** A collector talked to us. */
export function touch(worker, { version, mode } = {}) {
  if (worker.helperId) {
    getDb().prepare('UPDATE collectors SET last_seen_at = ?, version = COALESCE(?, version), mode = COALESCE(?, mode) WHERE id = ?')
      .run(nowIso(), version ? String(version).slice(0, 40) : null, mode ? String(mode).slice(0, 20) : null, worker.helperId);
  }
}

/** A worker's display name. */
export function nameOf(id) {
  if (id === SERVER.id) return SERVER.name;
  if (id === HOME.id) return HOME.name;
  const row = /^h\d+$/.test(id || '') && getDb().prepare('SELECT name FROM collectors WHERE id = ?').get(Number(id.slice(1)));
  return row ? row.name : 'A helper that was removed';
}

// ---------------------------------------------------------------- the admin page

export function list() {
  return getDb().prepare('SELECT id, name, email, created_at, disabled, last_seen_at, version, mode, invite_expires, coles_max FROM collectors ORDER BY id').all()
    .map(({ invite_expires: until, ...h }) => ({ ...h, disabled: !!h.disabled, worker: `h${h.id}`, inviteUntil: until && Date.parse(until) > Date.now() ? until : null }));
}

function get(id) {
  const row = getDb().prepare('SELECT * FROM collectors WHERE id = ?').get(Number(id));
  if (!row) throw httpError(404, 'No such helper');
  return row;
}

const isEmail = (v) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);

/** Approve a helper. Returns it with its token (shown once). */
export function add(name, email = null) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw httpError(400, 'Give the helper a name, e.g. “Sam’s PC”');
  email = email ? String(email).trim().slice(0, 200) : null;
  if (email && !isEmail(email)) throw httpError(400, 'That email address doesn’t look right');
  const token = newCollectorToken();
  const id = getDb().prepare('INSERT INTO collectors (name, email, token_hash, created_at) VALUES (?, ?, ?, ?)').run(name, email, hash(token), nowIso()).lastInsertRowid;
  return { ...list().find((h) => h.id === Number(id)), token };
}

const INVITE_DAYS = 7;

/** A link for a helper to download the collector themselves, for a week. Returns its token (shown once); an older link stops working. */
export function newInvite(id, email = undefined) {
  get(id);
  if (email !== undefined && email !== null && email !== '' && !isEmail(String(email).trim())) throw httpError(400, 'That email address doesn’t look right');
  const token = newCollectorToken();
  const until = new Date(Date.now() + INVITE_DAYS * 86400000).toISOString();
  getDb().prepare('UPDATE collectors SET invite_hash = ?, invite_expires = ?, email = COALESCE(?, email) WHERE id = ?')
    .run(hash(token), until, email ? String(email).trim() : null, Number(id));
  return { token, until };
}

/** The helper an invite link is for, if it's still good. */
export function byInvite(token) {
  if (!token || String(token).length < 24) return null;
  const row = getDb().prepare('SELECT id, name, disabled, invite_expires FROM collectors WHERE invite_hash = ?').get(hash(String(token)));
  if (!row || row.disabled || !(Date.parse(row.invite_expires) > Date.now())) return null;
  return { id: row.id, name: row.name, until: row.invite_expires };
}

/** Stop an invite link working. */
export function cancelInvite(id) {
  get(id);
  getDb().prepare('UPDATE collectors SET invite_hash = NULL, invite_expires = NULL WHERE id = ?').run(Number(id));
}

/** A new token for a helper (its old one stops working). */
export function newToken(id) {
  get(id);
  const token = newCollectorToken();
  getDb().prepare('UPDATE collectors SET token_hash = ? WHERE id = ?').run(hash(token), Number(id));
  return token;
}

/** A helper's own Coles cap (pages an hour), or null for the site's per-connection figure. */
export function colesMax(worker) {
  if (!/^h\d+$/.test(worker || '')) return null;
  return getDb().prepare('SELECT coles_max FROM collectors WHERE id = ?').get(Number(worker.slice(1)))?.coles_max ?? null;
}

export function setColesMax(id, n) {
  get(id);
  if (n !== null && (!Number.isInteger(n) || n < 1 || n > 600)) throw httpError(400, 'Pages an hour should be a whole number from 1 to 600 (or blank)');
  getDb().prepare('UPDATE collectors SET coles_max = ? WHERE id = ?').run(n, Number(id));
}

export function setDisabled(id, disabled) {
  get(id);
  getDb().prepare('UPDATE collectors SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, Number(id));
}

export function remove(id) {
  get(id);
  getDb().prepare('DELETE FROM collectors WHERE id = ?').run(Number(id));
}
