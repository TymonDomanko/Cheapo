// Emails the site's admins when price refreshes go wrong, so stale prices
// don't go unnoticed:
//  - a refresh fails, or finds far fewer products than last time (a store
//    changed its website, or started blocking us);
//  - the home collector stops sending prices.
// Each problem is emailed once (then at most daily while it lasts), and an
// "all good again" email follows when it's fixed.

import { getDb, nowIso } from './db.js';
import { STORES, storeName } from './stores.js';
import { getSetting } from './settings.js';
import { sendMail, emailHtml, siteUrl, siteName } from './mailer.js';

const REPEAT_AFTER_MS = 20 * 3600 * 1000;
const DROP_RATIO = 0.7; // fewer than 70% of last time's products counts as a problem
const COLLECTOR_QUIET_MS = 36 * 3600 * 1000;

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

/** Raise (or repeat, at most daily) an alert. */
async function raise(key, subject, lines) {
  const open = openAlert(key);
  if (open && Date.now() - Date.parse(open.sentAt) < REPEAT_AFTER_MS) return false;
  saveAlert(key, { subject, since: open?.since || nowIso(), sentAt: nowIso() });
  await email(subject, lines);
  return true;
}

/** Clear an alert, telling admins it's fixed. */
async function clear(key, subject, lines) {
  if (!openAlert(key)) return false;
  saveAlert(key, null);
  await email(subject, lines);
  return true;
}

const where = (run) => (run.store === 'iga' && run.location ? ` (IGA store ${run.location})` : '');

/** Look at a refresh that just finished. Never throws. */
export async function checkRun(run) {
  try {
    if (!run || process.env.ADMIN_ALERTS === 'false') return;
    const name = storeName(run.store);
    const key = keyFor(run.store, run.location);
    if (run.status === 'error') {
      return await raise(key, `${name} prices didn’t refresh`, [
        `The ${name}${where(run)} refresh${run.source === 'collector' ? ' from the home collector' : ''} failed: ${run.error || 'unknown error'}.`,
        'Prices for it stay as they were until a refresh works. If this keeps happening, the shop may have changed its website or be blocking this server — the home collector can help with blocking.',
      ]);
    }
    if (run.status !== 'ok') return;
    const prev = getDb().prepare(`SELECT products FROM scrape_runs WHERE store = ? AND COALESCE(location, '') = COALESCE(?, '')
      AND status = 'ok' AND products > 0 AND id < ? ORDER BY id DESC LIMIT 1`).get(run.store, run.location || null, run.id);
    if (prev && run.products < prev.products * DROP_RATIO) {
      return await raise(key, `${name} refresh found far fewer products`, [
        `The latest ${name}${where(run)} refresh found ${run.products.toLocaleString()} products; the one before found ${prev.products.toLocaleString()}.`,
        'Some of the shop’s website may have stopped working for us. Products it didn’t find are shown as unavailable until they turn up again.',
      ]);
    }
    return await clear(key, `${name} prices are refreshing again`, [`The latest ${name}${where(run)} refresh worked: ${run.products.toLocaleString()} products.`]);
  } catch (e) {
    console.error(`[admin alert] ${e.message}`);
  }
}

/** Daily: has the home collector gone quiet? */
export async function checkCollector({ serverStores } = {}) {
  try {
    if (!getSetting('COLLECTOR_TOKEN') || process.env.ADMIN_ALERTS === 'false') return null;
    const crawled = serverStores ? serverStores() : STORES;
    const fromCollector = STORES.filter((s) => !crawled.includes(s));
    if (!fromCollector.length) return null;
    const last = getDb().prepare(`SELECT MAX(finished_at) at FROM scrape_runs WHERE source = 'collector' AND status = 'ok'
      AND store IN (${fromCollector.map(() => '?').join(',')})`).get(...fromCollector).at;
    const quiet = !last || Date.now() - Date.parse(last) > COLLECTOR_QUIET_MS;
    const names = fromCollector.map(storeName).join(' and ');
    if (quiet) {
      return await raise('alert:collector', 'The home collector has gone quiet', [
        last ? `The home collector last sent ${names} prices on ${new Date(last).toLocaleString('en-AU')}.` : `The home collector hasn’t sent any ${names} prices yet.`,
        'Is the computer it runs on switched on and online? The admin page shows when it last connected.',
      ]);
    }
    return await clear('alert:collector', 'The home collector is sending prices again', [`${names} prices are coming in again.`]);
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
