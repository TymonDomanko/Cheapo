// A server secret for signing things like one-click unsubscribe links.
// Set APP_SECRET, or one is generated once and kept in the database.

import crypto from 'node:crypto';
import { getDb } from './db.js';

let cached = null;

export function appSecret() {
  if (cached) return cached;
  if (process.env.APP_SECRET) return (cached = process.env.APP_SECRET);
  const d = getDb();
  const row = d.prepare("SELECT value FROM app_settings WHERE key = 'secret'").get();
  if (row) return (cached = row.value);
  const value = crypto.randomBytes(32).toString('base64url');
  d.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('secret', ?)").run(value);
  return (cached = d.prepare("SELECT value FROM app_settings WHERE key = 'secret'").get().value);
}

/** Short signature proving a value came from us (e.g. "unsubscribe:<userId>:weekly"). */
export function sign(value) {
  return crypto.createHmac('sha256', appSecret()).update(value).digest('base64url').slice(0, 32);
}

export function verifySignature(value, signature) {
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(String(signature || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
