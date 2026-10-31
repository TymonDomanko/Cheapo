// Emails the site's admins about price refreshes, so stale prices don't go
// unnoticed — in one daily report, never more than one a day:
//  - what needs a look: a refresh that failed, or found far fewer products
//    than last time (a shop changed its website, or is blocking us), or a
//    helper that stopped connecting;
//  - what's working again;
//  - and the last day at a glance: each shop's refreshes, Coles' steady
//    refresh (with its bot checks), and each helper.
// It's only sent when there's news (something new broke or got fixed); while
// a problem lasts it's repeated every few days. Coles bot checks are routine
// (the connection pauses and carries on), so they're counted, not reported,
// unless Coles stops getting anywhere for a day.

import { getDb, nowIso } from './db.js';
import { storeName, STORES } from './stores.js';
import { sendMail, emailHtml, siteUrl, siteName, escapeHtml } from './mailer.js';
import * as helpers from './helpers.js';

const DROP_RATIO = 0.7; // fewer than 70% of last time's products counts as a problem
const COLLECTOR_QUIET_MS = 36 * 3600 * 1000;
const REMIND_AFTER_MS = Number(process.env.ADMIN_REMIND_DAYS ?? 3) * 86400000; // problems that carry on
const DAY_MS = 86400000;
const PENDING = 'alert-pending';
const REPORT = 'alert-report'; // { day, at, colesPages }

const keyFor = (store, location) => `alert:${store}${store === 'iga' ? '' : location ? `:${location}` : ''}`;
/** Today's date where the site is (TZ), e.g. 2026-10-31. */
const localDay = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA', { timeZone: process.env.TZ || undefined });
const when = (iso) => new Date(iso).toLocaleString('en-AU', { timeZone: process.env.TZ || undefined, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const ago = (iso) => {
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  return h < 1 ? 'under an hour ago' : h < 48 ? `${Math.round(h)} hours ago` : `${Math.round(h / 24)} days ago`;
};

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

// Lines starting "## " are section headings.
async function email(subject, lines) {
  const to = admins();
  if (!to.length) return 0;
  const adminUrl = `${siteUrl()}/#admin`;
  const text = lines.map((l) => (l.startsWith('## ') ? `\n${l.slice(3).toUpperCase()}` : l)).join('\n\n');
  const body = lines.map((l) => (l.startsWith('## ')
    ? `<h2 style="font-size:15px;margin:18px 0 8px">${escapeHtml(l.slice(3))}</h2>`
    : `<p style="font-size:14px;line-height:1.5;margin:0 0 8px">${escapeHtml(l)}</p>`)).join('');
  for (const a of to) {
    await sendMail({
      to: a.email,
      subject: `[${siteName()}] ${subject}`,
      text: `${text}\n\nAdmin page: ${adminUrl}`,
      html: emailHtml({ heading: subject, extraHtml: body, button: { label: 'Open the admin page', url: adminUrl } }),
      kind: 'admin-alert',
    }).catch((e) => console.error(`[admin alert] ${e.message}`));
  }
  return to.length;
}

// ---------------------------------------------------------------- what to tell
// Waiting for the next report: { notes: [{kind: 'problem'|'fixed', key, subject, lines, isNew, at}] }.

const pending = () => openAlert(PENDING) || { notes: [] };

function note(n) {
  const p = pending();
  const earlier = p.notes.find((x) => x.key === n.key);
  p.notes = p.notes.filter((x) => x.key !== n.key);
  // Broke and was fixed again before the report: nothing to tell.
  if (!(n.kind === 'fixed' && earlier?.kind === 'problem' && earlier.isNew)) p.notes.push({ ...n, at: nowIso() });
  saveAlert(PENDING, p);
}

/** Raise an alert (the details are kept up to date; it's reported in the next daily report). */
function raise(key, subject, lines) {
  const open = openAlert(key);
  saveAlert(key, { subject, lines, since: open?.since || nowIso(), sentAt: open?.sentAt || null });
  if (!open) note({ kind: 'problem', key, subject, lines, isNew: true });
  else {
    // Waiting to be reported: report the latest details.
    const p = pending();
    const waiting = p.notes.find((n) => n.key === key && n.kind === 'problem');
    if (waiting) Object.assign(waiting, { subject, lines }), saveAlert(PENDING, p);
  }
  return true;
}

/** Clear an alert: the next report says it's working again. */
function clear(key, subject, lines) {
  if (!openAlert(key)) return false;
  saveAlert(key, null);
  note({ kind: 'fixed', key, subject, lines });
  return true;
}

const where = (run) => (run.store === 'iga' && run.location ? ` (IGA store ${run.location})` : '');

/** Look at a refresh that just finished. Never throws. */
export async function checkRun(run) {
  try {
    if (!run || process.env.ADMIN_ALERTS === 'false') return;
    const name = storeName(run.store);
    const key = keyFor(run.store, run.location);
    // A bot check on Coles' steady refresh is routine: that connection pauses and carries on (counted in the report).
    if (run.status === 'error' && run.store === 'coles' && /bot check/i.test(run.error || '')) return false;
    if (run.status === 'error') {
      return raise(key, `${name} prices didn’t refresh`, [
        `The ${name}${where(run)} refresh${run.source === 'collector' ? ' from a helper' : ''} failed: ${run.error || 'unknown error'}.`,
        'Prices for it stay as they were until a refresh works. If this keeps happening, the shop may have changed its website or be blocking this connection — a helper on another connection can cover it.',
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

// ---------------------------------------------------------------- the daily report

/** Each shop's last day: "Woolworths: refreshed, 21,856 products (Thu 4:52 am)". */
function shopLines(since) {
  const d = getDb();
  const out = [];
  for (const store of STORES) {
    const runs = d.prepare('SELECT * FROM scrape_runs WHERE store = ? AND started_at >= ? ORDER BY id').all(store, since);
    const ok = runs.filter((r) => r.status === 'ok');
    const failed = runs.filter((r) => r.status === 'error');
    const name = storeName(store);
    if (store === 'coles' && ok.length + failed.length === runs.length && !ok.length) continue; // in its own section
    if (store === 'iga') {
      const stores = new Set(runs.map((r) => r.location)).size;
      if (runs.length) out.push(`${name}: ${new Set(ok.map((r) => r.location)).size} of ${stores} stores refreshed${failed.length ? ` (${failed.length} failed: ${failed.at(-1).error})` : ''}.`);
      continue;
    }
    const last = d.prepare("SELECT * FROM scrape_runs WHERE store = ? AND status = 'ok' AND products > 0 ORDER BY id DESC LIMIT 1").get(store);
    if (ok.length) out.push(`${name}: refreshed, ${ok.at(-1).products.toLocaleString()} product${ok.at(-1).products === 1 ? '' : 's'} (${when(ok.at(-1).finished_at || ok.at(-1).started_at)})${failed.length ? `; ${failed.length} failed attempt${failed.length === 1 ? '' : 's'}` : ''}.`);
    else if (failed.length) out.push(`${name}: didn’t refresh — ${failed.at(-1).error}${last ? ` (last good refresh ${ago(last.finished_at || last.started_at)})` : ''}.`);
    else if (runs.length) out.push(`${name}: still refreshing (started ${when(runs.at(-1).started_at)}).`);
    else if (last) out.push(`${name}: no refresh in the last day (last ${ago(last.finished_at || last.started_at)}).`);
  }
  return out;
}

/** Coles' steady refresh: how far the pass has got since the last report, and the bot checks. */
async function colesLines(since, lastReport) {
  const colesLive = await import('./coles-live.js');
  if (!colesLive.enabled()) return { lines: [], pages: null, stuck: false };
  const st = colesLive.status();
  const lines = [];
  const pass = st.pass;
  if (pass?.pages) lines.push(`Coles: this pass is ${Math.round((pass.pagesDone / pass.pages) * 100)}% through the shop (${pass.pagesDone} of ${pass.pages} pages, started ${when(pass.startedAt)}).`);
  if (st.lastPassAt) lines.push(`Last full pass finished ${when(st.lastPassAt)}.`);
  // Which connection: the message names it ("…bot check (Home collector)…"), else the run's worker.
  const checks = {};
  for (const r of getDb().prepare("SELECT worker, error FROM scrape_runs WHERE store = 'coles' AND status = 'error' AND error LIKE '%bot check%' AND started_at >= ?").all(since)) {
    const who = r.error.match(/bot check \(([^)]+)\)/)?.[1] || helpers.nameOf(r.worker || 'server');
    checks[who] = (checks[who] || 0) + 1;
  }
  if (Object.keys(checks).length) lines.push(`Bot checks in the last day: ${Object.entries(checks).map(([who, n]) => `${who} ${n}`).join(', ')}. Each pauses that connection (2 hours, doubling) while the others carry on.`);
  const paused = st.workers.filter((w) => w.blockedUntil);
  if (paused.length) lines.push(`Paused now: ${paused.map((w) => `${w.name} until ${when(w.blockedUntil)}`).join(', ')}.`);
  // Stuck: the pass hasn't moved since the last report, a day or more ago.
  const stuck = lastReport?.colesPages != null && pass && pass.pagesDone <= lastReport.colesPages && Date.now() - Date.parse(lastReport.at) >= DAY_MS - 3600000;
  return { lines, pages: pass?.pagesDone ?? null, stuck };
}

/** Each helper: last connection, version, and any shop it's paused for. */
async function helperLines() {
  const [{ latestCollectorVersion }, sharing] = await Promise.all([import('./collector-bundle.js'), import('./sharing.js')]);
  const latest = latestCollectorVersion();
  const shared = Object.entries(sharing.status());
  return helpers.list().map((h) => {
    if (h.disabled) return `${h.name}: turned off.`;
    if (!h.last_seen_at) return `${h.name}: hasn’t connected yet.`;
    const paused = shared.flatMap(([store, s]) => s.paused.filter((p) => p.id === `h${h.id}`).map(() => storeName(store)));
    return `${h.name}: last connected ${ago(h.last_seen_at)}${h.version && h.version !== latest ? ' (an older version: it updates itself)' : ''}${paused.length ? `; paused for ${paused.join(', ')} after a bot check` : ''}.`;
  });
}

/**
 * The daily report (the server sends it each morning, after the refresh).
 * At most one a day, and only when there's news, or problems are still open
 * and the last reminder was a few days ago. `force` sends whatever there is
 * now (tests). Returns how many admins were emailed.
 */
export async function sendDailyReport({ force = false } = {}) {
  if (process.env.ADMIN_ALERTS === 'false' && !force) return 0;
  const last = openAlert(REPORT);
  if (!force && last?.day === localDay()) return 0;
  await checkCollector();
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const coles = await colesLines(since, last).catch(() => ({ lines: [], pages: null, stuck: false }));
  if (coles.stuck) {
    raise('alert:coles-stuck', 'Coles prices aren’t getting through', ['Coles’ steady refresh hasn’t fetched any new pages for a day: every connection is being stopped by bot checks. Lowering the pages an hour on the Admin page, or adding a helper on another connection, usually helps.']);
  } else if (coles.pages != null) {
    clear('alert:coles-stuck', 'Coles prices are getting through again', ['Coles’ steady refresh is fetching pages again.']);
  }

  const p = pending();
  const open = openAlerts().filter((a) => a.key !== PENDING && a.key !== REPORT);
  const fresh = new Set(p.notes.map((n) => n.key));
  const ongoing = open.filter((a) => !fresh.has(a.key));
  const remind = ongoing.length && (!last || Date.now() - Date.parse(last.at) >= REMIND_AFTER_MS || ongoing.some((a) => !a.sentAt || Date.now() - Date.parse(a.sentAt) >= REMIND_AFTER_MS));
  if (!force && !p.notes.length && !remind) return 0;

  const problems = p.notes.filter((n) => n.kind === 'problem');
  const fixed = p.notes.filter((n) => n.kind === 'fixed');
  const counts = [problems.length && `${problems.length} new problem${problems.length === 1 ? '' : 's'}`,
    ongoing.length && `${ongoing.length} still open`, fixed.length && `${fixed.length} fixed`].filter(Boolean);
  const subject = `Daily report: ${counts.join(', ') || 'all working'}`;
  const lines = [];
  if (problems.length) {
    lines.push(`## Needs a look (${problems.length})`);
    for (const n of problems) lines.push(`⚠️ ${n.subject} (since ${when(n.at)}). ${n.lines.join(' ')}`);
  }
  if (ongoing.length) {
    lines.push(`## Still not working (${ongoing.length})`);
    for (const a of ongoing) lines.push(`⚠️ ${a.subject} — since ${when(a.since)}.${a.lines ? ` ${a.lines.join(' ')}` : ''}`);
  }
  if (fixed.length) {
    lines.push(`## Working again (${fixed.length})`);
    for (const n of fixed) lines.push(`✓ ${n.subject}. ${n.lines.join(' ')}`);
  }
  const shops = shopLines(since);
  if (shops.length || coles.lines.length) lines.push('## The last day', ...shops, ...coles.lines);
  const helperInfo = await helperLines().catch(() => []);
  if (helperInfo.length) lines.push('## Helpers', ...helperInfo);

  saveAlert(PENDING, null);
  for (const a of open) saveAlert(a.key, { ...a, key: undefined, sentAt: nowIso() });
  saveAlert(REPORT, { day: localDay(), at: nowIso(), colesPages: coles.pages });
  return email(subject, lines);
}

/** Problems admins have been told about and that aren't fixed yet, for the admin page. */
export function openAlerts() {
  return getDb().prepare("SELECT key, value FROM app_settings WHERE key LIKE 'alert:%'").all()
    .map((r) => ({ key: r.key, ...JSON.parse(r.value) }));
}
