// Who is collecting prices: this server, the site's own home collector (the
// COLLECTOR_TOKEN in Site settings), and helpers — collectors an admin has
// approved, each with its own token, so they can be named, seen and turned off
// one by one. They share the work; they don't add to how much is asked of a
// shop (see src/coles-live.js and src/claims.js).

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
  return getDb().prepare('SELECT id, name, created_at, disabled, last_seen_at, version, mode FROM collectors ORDER BY id').all()
    .map((h) => ({ ...h, disabled: !!h.disabled, worker: `h${h.id}` }));
}

function get(id) {
  const row = getDb().prepare('SELECT * FROM collectors WHERE id = ?').get(Number(id));
  if (!row) throw httpError(404, 'No such helper');
  return row;
}

/** Approve a helper. Returns it with its token (shown once). */
export function add(name) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw httpError(400, 'Give the helper a name, e.g. “Sam’s PC”');
  const token = newCollectorToken();
  const id = getDb().prepare('INSERT INTO collectors (name, token_hash, created_at) VALUES (?, ?, ?)').run(name, hash(token), nowIso()).lastInsertRowid;
  return { ...list().find((h) => h.id === Number(id)), token };
}

/** A new token for a helper (its old one stops working). */
export function newToken(id) {
  get(id);
  const token = newCollectorToken();
  getDb().prepare('UPDATE collectors SET token_hash = ? WHERE id = ?').run(hash(token), Number(id));
  return token;
}

export function setDisabled(id, disabled) {
  get(id);
  getDb().prepare('UPDATE collectors SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, Number(id));
}

export function remove(id) {
  get(id);
  getDb().prepare('DELETE FROM collectors WHERE id = ?').run(Number(id));
}
