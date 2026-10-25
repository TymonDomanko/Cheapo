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
  // Prices for: which Coles store's prices to collect (fruit and veg, and some
  // specials, differ by area). A number, or the store's page on coles.com.au
  // (…/find-stores/coles/nsw/bondi-junction-0381). Unset: Coles' default (Melbourne).
  COLES_STORE_ID: {
    check(v) {
      const id = String(v).trim().match(/(\d{3,5})\/?(?:[?#].*)?$/)?.[1];
      if (!id) throw httpError(400, 'Enter the Coles store’s number, or paste its page from coles.com.au/find-stores');
      return id;
    },
  },
  // The state whose Liquorland prices are collected.
  LIQUOR_STATE: {
    check(v) {
      const s = String(v).trim().toLowerCase();
      if (!['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'act', 'nt'].includes(s)) throw httpError(400, 'Choose a state: NSW, VIC, QLD, WA, SA, TAS, ACT or NT');
      return s;
    },
  },
  // Shown to shoppers: where the prices are for, e.g. "Bondi Junction, NSW".
  PRICE_AREA: {
    check(v) {
      if (v.length > 60) throw httpError(400, 'Keep the area under 60 characters');
      return v;
    },
  },
  // Coles pages an hour, this server and every helper together.
  COLES_PAGES_PER_HOUR: {
    check(v) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 600) throw httpError(400, 'Coles pages an hour should be a whole number from 0 to 600');
      return String(n);
    },
  },
  // The most Coles pages an hour any one connection fetches (this server or a helper); 40 when unset.
  COLES_MAX_PER_CONNECTION: {
    check(v) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 600) throw httpError(400, 'Coles pages an hour per connection should be a whole number from 1 to 600');
      return String(n);
    },
  },
  // What to keep a shop's refresh with ("woolworths=h3,aldi=server", or
  // "woolworths=@1200": whichever connections Woolworths gives store 1200), so
  // its prices come from one place. Others step in only for what it can't do.
  PREFERRED_CONNECTIONS: {
    check(v) {
      const pairs = String(v).split(',').map((s) => s.trim()).filter(Boolean).map((p) => p.split('=').map((s) => s.trim()));
      for (const [store, w] of pairs) {
        if (!STORES.includes(store)) throw httpError(400, `Unknown store: ${store}`);
        if (!/^(server|h\d+|@[\w-]{1,20})$/.test(w || '')) throw httpError(400, `Choose a connection or a store for ${store}`);
      }
      return pairs.map((p) => p.join('=')).join(',');
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
