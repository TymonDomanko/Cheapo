// Emails the site's admins when price refreshes go wrong, so stale prices
// don't go unnoticed:
//  - a refresh fails, or finds far fewer products than last time (a store
//    changed its website, or started blocking us);
//  - a helper stops connecting.
// Each problem is reported once (then at most daily while it lasts), and
// again when it's fixed. While prices are refreshing nothing is sent: what
// the refresh turned up is collected and emailed as one summary once every
// shop has finished.

import { getDb, nowIso } from './db.js';
import { storeName } from './stores.js';
import { sendMail, emailHtml, siteUrl, siteName } from './mailer.js';
import * as helpers from './helpers.js';

const REPEAT_AFTER_MS = 20 * 3600 * 1000;
const DROP_RATIO = 0.7; // fewer than 70% of last time's products counts as a problem
const COLLECTOR_QUIET_MS = 36 * 3600 * 1000;
// After the last run finishes, wait a moment before sending: IGA stores are
// fetched a few at a time, so another may be about to start.
const SETTLE_MS = Number(process.env.ADMIN_ALERT_SETTLE_MS || 2 * 60 * 1000);
const PENDING = 'alert-pending';
// …but don't hold news for longer than this (a home collector that died mid-run never finishes).
const MAX_HOLD_MS = 3 * 3600 * 1000;

const keyFor = (store, location) => `alert:${store}${store === 'iga' ? '' : location ? `:${location}` : ''}`;

function openAlert(key) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}
function saveAlert(key, value) {
  const d = getDb();
  if (value == null) d.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  else {
    d.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
}

function admins() {
  return getDb().prepare('SELECT email, name FROM users WHERE is_admin = 1').all();
}

async function email(subject, lines) {
  const to = admins();
  if (!to.length) return 0;
  const adminUrl = `${siteUrl()}/#admin`;
  for (const a of to) {
    await sendMail({
      to: a.email,
      subject: `[${siteName()}] ${subject}`,
      text: `${lines.join('\n\n')}\n\nAdmin page: ${adminUrl}`,
      html: emailHtml({ heading: subject, paragraphs: lines, button: { label: 'Open the admin page', url: adminUrl } }),
      kind: 'admin-alert',
    }).catch((e) => console.error(`[admin alert] ${e.message}`));
  }
  return to.length;
}

// ---------------------------------------------------------------- the summary
// Waiting to be sent: { notes: [{kind: 'problem'|'fixed', key, subject, lines, isNew}], runs: [...] }.
// Kept in the database so a restart mid-refresh doesn't lose it.

const pending = () => openAlert(PENDING) || { notes: [], runs: [], since: nowIso() };

function note(n) {
  const p = pending();
  const earlier = p.notes.find((x) => x.key === n.key);
  p.notes = p.notes.filter((x) => x.key !== n.key);
  // Broke and was fixed again within one refresh: nothing to tell.
  if (!(n.kind === 'fixed' && earlier?.kind === 'problem' && earlier.isNew)) p.notes.push(n);
  saveAlert(PENDING, p);
  scheduleSummary();
}

/** Raise (or repeat, at most daily) an alert. */
function raise(key, subject, lines) {
  const open = openAlert(key);
  if (open && Date.now() - Date.parse(open.sentAt) < REPEAT_AFTER_MS) return false;
  saveAlert(key, { subject, since: open?.since || nowIso(), sentAt: nowIso() });
  note({ kind: 'problem', key, subject, lines, isNew: !open });
  return true;
}

/** Clear an alert, telling admins it's fixed. */
function clear(key, subject, lines) {
  if (!openAlert(key)) return false;
  saveAlert(key, null);
  note({ kind: 'fixed', key, subject, lines });
  return true;
}

/** Is a refresh still going? (Ignores runs stuck for hours: those are a problem of their own.) */
function refreshing() {
  const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  return getDb().prepare("SELECT COUNT(*) n FROM scrape_runs WHERE status = 'running' AND started_at > ?").get(since).n > 0;
}

let timer = null;
function scheduleSummary() {
  clearTimeout(timer);
  timer = setTimeout(() => sendSummary().catch((e) => console.error(`[admin alert] ${e.message}`)), SETTLE_MS);
  timer.unref?.();
}

function runsLine(runs) {
  const byStore = new Map();
  for (const r of runs) {
    if (!byStore.has(r.store)) byStore.set(r.store, []);
    byStore.get(r.store).push(r);
  }
  return [...byStore].map(([store, rs]) => {
    const failed = rs.filter((r) => r.status === 'error').length;
    if (store === 'iga' && rs.length > 1) {
      return `IGA: ${rs.length - failed} of ${rs.length} stores refreshed${failed ? ` (${failed} failed)` : ''}`;
    }
    const last = rs.at(-1);
    return last.status === 'error' ? `${storeName(store)}: failed` : `${storeName(store)}: ${last.products.toLocaleString()} products`;
  }).join(' · ');
}

/**
 * Email what the refresh turned up, once nothing is refreshing any more.
 * `force` sends now regardless (tests, or when asked). Returns how many admins were emailed.
 */
export async function sendSummary({ force = false } = {}) {
  clearTimeout(timer);
  const held = Date.now() - Date.parse(openAlert(PENDING)?.since || nowIso());
  if (!force && refreshing() && held < MAX_HOLD_MS) {
    scheduleSummary();
    return 0;
  }
  const p = pending();
  saveAlert(PENDING, null);
  if (!p.notes.length) return 0;
  const problems = p.notes.filter((n) => n.kind === 'problem');
  const fixed = p.notes.filter((n) => n.kind === 'fixed');
  const subject = p.notes.length === 1 ? p.notes[0].subject
    : [problems.length && `${problems.length} problem${problems.length === 1 ? '' : 's'}`, fixed.length && `${fixed.length} fixed`]
      .filter(Boolean).join(', ').replace(/^./, (c) => `Price refresh: ${c}`);
  const lines = [];
  if (p.runs.length) lines.push(`This refresh: ${runsLine(p.runs)}.`);
  if (problems.length) {
    if (p.notes.length > 1) lines.push(`Needs a look (${problems.length}):`);
    for (const n of problems) lines.push(...(p.notes.length > 1 ? [`⚠️ ${n.subject}. ${n.lines.join(' ')}`] : n.lines));
  }
  if (fixed.length) {
    if (p.notes.length > 1) lines.push(`Working again (${fixed.length}):`);
    for (const n of fixed) lines.push(...(p.notes.length > 1 ? [`✓ ${n.subject}. ${n.lines.join(' ')}`] : n.lines));
  }
  return email(subject, lines);
}

const where = (run) => (run.store === 'iga' && run.location ? ` (IGA store ${run.location})` : '');

/** After a restart: send anything a refresh left waiting. */
export function resumeSummary() {
  if (openAlert(PENDING)) scheduleSummary();
}

/** Look at a refresh that just finished. Never throws. */
export async function checkRun(run) {
  try {
    if (!run || process.env.ADMIN_ALERTS === 'false') return;
    const name = storeName(run.store);
    const key = keyFor(run.store, run.location);
    const p = pending();
    p.runs.push({ store: run.store, location: run.location, status: run.status, products: run.products || 0 });
    saveAlert(PENDING, p);
    scheduleSummary();
    if (run.status === 'error') {
      return raise(key, `${name} prices didn’t refresh`, [
        `The ${name}${where(run)} refresh${run.source === 'collector' ? ' from a helper' : ''} failed: ${run.error || 'unknown error'}.`,
        'Prices for it stay as they were until a refresh works. If this keeps happening, the shop may have changed its website or be blocking this server — the home collector can help with blocking.',
      ]);
    }
    if (run.status !== 'ok') return;
    const prev = getDb().prepare(`SELECT products FROM scrape_runs WHERE store = ? AND COALESCE(location, '') = COALESCE(?, '')
      AND status = 'ok' AND products > 0 AND id < ? ORDER BY id DESC LIMIT 1`).get(run.store, run.location || null, run.id);
    if (prev && run.products < prev.products * DROP_RATIO) {
      return raise(key, `${name} refresh found far fewer products`, [
        `The latest ${name}${where(run)} refresh found ${run.products.toLocaleString()} products; the one before found ${prev.products.toLocaleString()}.`,
        'Some of the shop’s website may have stopped working for us. Products it didn’t find are shown as unavailable until they turn up again.',
      ]);
    }
    return clear(key, `${name} prices are refreshing again`, [`The latest ${name}${where(run)} refresh worked: ${run.products.toLocaleString()} products.`]);
  } catch (e) {
    console.error(`[admin alert] ${e.message}`);
  }
}

/** Daily: has a helper (one that's turned on and has connected before) gone quiet? */
export async function checkCollector() {
  try {
    if (process.env.ADMIN_ALERTS === 'false') return null;
    const quiet = helpers.list().filter((x) => !x.disabled && x.last_seen_at && Date.now() - Date.parse(x.last_seen_at) > COLLECTOR_QUIET_MS);
    if (quiet.length) {
      return raise('alert:collector', quiet.length === 1 ? `${quiet[0].name} has gone quiet` : `${quiet.length} helpers have gone quiet`, [
        ...quiet.map((x) => `${x.name} last connected on ${new Date(x.last_seen_at).toLocaleString('en-AU')}.`),
        'Is the computer it runs on switched on and online? The others carry on with its share. Admin → Site settings → Helpers shows each one.',
      ]);
    }
    return clear('alert:collector', 'The helpers are connecting again', ['Every helper that’s turned on has connected in the last day and a half.']);
  } catch (e) {
    console.error(`[admin alert] ${e.message}`);
    return null;
  }
}

/** Problems admins have been told about and that aren't fixed yet, for the admin page. */
export function openAlerts() {
  return getDb().prepare("SELECT key, value FROM app_settings WHERE key LIKE 'alert:%'").all()
    .map((r) => ({ key: r.key, ...JSON.parse(r.value) }));
}
