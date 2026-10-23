// Site settings an admin can change on the Admin page. Each one can also be
// set as an environment variable (.env), which always wins — handy for
// keeping a mail password out of the database and its backups.

import crypto from 'node:crypto';
import { getDb } from './db.js';
import { STORES } from './stores.js';

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const isEmail = (v) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);

/** key → how to check a value an admin enters (returns the value to store). */
const SETTINGS = {
  SMTP_URL: {
    secret: true,
    check(v) {
      let u;
      try {
        u = new URL(v);
      } catch {
        throw httpError(400, 'That mail server address isn’t valid');
      }
      if (!['smtp:', 'smtps:'].includes(u.protocol) || !u.hostname) throw httpError(400, 'The mail server must be an smtp:// or smtps:// address');
      return v;
    },
  },
  MAIL_FROM: {
    check(v) {
      if (!isEmail(v.match(/<([^>]+)>/)?.[1] || v)) throw httpError(400, '“From” needs an email address, e.g. Groceries <alerts@example.com>');
      return v;
    },
  },
  SITE_URL: {
    check(v) {
      let u;
      try {
        u = new URL(v);
      } catch {
        throw httpError(400, 'Enter the site’s full address, e.g. https://groceries.example.com');
      }
      if (!['http:', 'https:'].includes(u.protocol)) throw httpError(400, 'The site address must start with https://');
      return u.origin;
    },
  },
  CONTACT_EMAIL: {
    check(v) {
      if (!isEmail(v)) throw httpError(400, 'Enter a valid contact email');
      return v;
    },
  },
  SITE_OPERATOR: {
    check(v) {
      if (v.length > 120) throw httpError(400, 'Keep it under 120 characters');
      return v;
    },
  },
  COLLECTOR_TOKEN: {
    secret: true,
    check(v) {
      if (v.length < 24) throw httpError(400, 'Use a token of at least 24 characters (or press Generate)');
      return v;
    },
  },
  SERVER_SCRAPE_STORES: {
    check(v) {
      const list = [...new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean))];
      const bad = list.filter((s) => !STORES.includes(s));
      if (bad.length) throw httpError(400, `Unknown store: ${bad.join(', ')}`);
      if (!list.length) throw httpError(400, 'Choose at least one store for this server to crawl');
      return list.join(',');
    },
  },
};

export const SETTING_KEYS = Object.keys(SETTINGS);

let cache = null;
function stored() {
  if (!cache) {
    cache = Object.fromEntries(getDb().prepare("SELECT key, value FROM app_settings WHERE key LIKE 'cfg:%'").all()
      .map((r) => [r.key.slice(4), r.value]));
  }
  return cache;
}

const fromEnv = (key) => {
  const v = process.env[key];
  return v != null && v !== '' ? v : null;
};

/** The setting's value: .env first, then what an admin saved, else null. */
export function getSetting(key) {
  return fromEnv(key) ?? stored()[key] ?? null;
}

/** Where a setting comes from, for the admin page. */
export function settingSource(key) {
  if (fromEnv(key) != null) return 'env';
  return stored()[key] != null ? 'admin' : 'unset';
}

/** Save (or clear, with null/'') a setting from the admin page. */
export function setSetting(key, value) {
  const def = SETTINGS[key];
  if (!def) throw httpError(400, `Unknown setting ${key}`);
  if (fromEnv(key) != null) throw httpError(409, `${key} is set in the server’s .env file — change it there`);
  const d = getDb();
  const v = value == null ? '' : String(value).trim();
  if (!v) d.prepare('DELETE FROM app_settings WHERE key = ?').run(`cfg:${key}`);
  else {
    d.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(`cfg:${key}`, def.check(v));
  }
  cache = null;
  for (const fn of listeners) fn(key);
}

const listeners = [];
/** Run `fn(key)` whenever an admin changes a setting (e.g. to reconnect to a new mail server). */
export function onSettingChange(fn) {
  listeners.push(fn);
}

export function newCollectorToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Mail server settings split into fields; the password is never sent back, only whether one is set. */
export function smtpParts() {
  const url = getSetting('SMTP_URL');
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : u.protocol === 'smtps:' ? 465 : 587,
      secure: u.protocol === 'smtps:',
      user: decodeURIComponent(u.username || ''),
      passwordSet: !!u.password,
    };
  } catch {
    return null;
  }
}

/** Build an SMTP_URL from form fields; a blank password keeps the saved one. */
export function smtpUrlFrom({ host, port, secure, user, password }) {
  host = String(host || '').trim();
  if (!host) return '';
  if (!/^[a-z0-9.-]+$/i.test(host)) throw httpError(400, 'Enter just the mail server’s host name, e.g. smtp.resend.com');
  const p = Number(port) || (secure ? 465 : 587);
  if (!(p > 0 && p < 65536)) throw httpError(400, 'Port should be a number like 465 or 587');
  let pass = password ? String(password) : '';
  if (!pass) {
    const old = getSetting('SMTP_URL');
    try {
      pass = old ? decodeURIComponent(new URL(old).password) : '';
    } catch {
      pass = '';
    }
  }
  const auth = user ? `${encodeURIComponent(String(user).trim())}${pass ? `:${encodeURIComponent(pass)}` : ''}@` : '';
  return `${secure ? 'smtps' : 'smtp'}://${auth}${host}:${p}`;
}

/** What the Admin page shows for each setting (secrets masked). */
export function describeSettings() {
  const out = {};
  for (const key of SETTING_KEYS) {
    const value = getSetting(key);
    out[key] = { source: settingSource(key), set: value != null, value: SETTINGS[key].secret ? null : value };
  }
  out.SMTP_URL.parts = smtpParts();
  return out;
}
