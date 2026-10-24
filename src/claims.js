// Sharing the daily refresh of each shop between this server and the
// collectors (the site's home collector and approved helpers).
//
// Each shop is refreshed once a day, after the scheduled time (SCRAPE_CRON),
// by one connection:
//   - a shop this server crawls gets the first go (90 minutes from the
//     scheduled time);
//   - after that, or straight away for a shop this server doesn't crawl, the
//     first collector to ask takes it;
//   - a connection whose refresh of a shop failed today (blocked, say) isn't
//     given it again today, so another one tries.
// Coles in steady mode is shared page by page instead (src/coles-live.js), and
// IGA (one refresh per store) stays on this server.

import { getDb } from './db.js';
import { SCRAPERS, startRun, serverStores, scrapeStatus } from './scrapers/index.js';
import { nextRun } from './mini-cron.js';
import * as colesLive from './coles-live.js';

const SERVER_FIRST_MS = 90 * 60 * 1000;
const RUN_STUCK_MS = 3 * 3600 * 1000; // a run still "running" after this long has been abandoned

let clock = () => Date.now();
/** Tests: pretend it's a different time. */
export function setClock(fn) {
  clock = fn;
}

/** When the daily refresh last fell due (the latest SCRAPE_CRON time). */
export function lastScheduled(now = clock()) {
  const expr = process.env.SCRAPE_CRON ?? '15 4 * * *';
  if (!expr) return new Date(now - 24 * 3600 * 1000);
  let t = nextRun(expr, new Date(now - 8 * 86400000), process.env.TZ || undefined);
  for (;;) {
    const n = nextRun(expr, t, process.env.TZ || undefined);
    if (n.getTime() > now) return t;
    t = n;
  }
}

/** Shops a collector may be handed (not IGA; not Coles while it's refreshed page by page). */
export const shareable = () => Object.keys(SCRAPERS).filter((s) => s !== 'iga' && !(s === 'coles' && colesLive.enabled()));

function runs(store, since) {
  return getDb().prepare('SELECT status, worker, source, started_at FROM scrape_runs WHERE store = ? AND location IS NULL AND started_at >= ?')
    .all(store, since);
}

/** Has `store` been refreshed since the scheduled time, or is someone on it now? */
function doneOrBusy(store, since, now) {
  if (scrapeStatus[store]?.running) return true;
  return runs(store, since).some((r) => (r.status === 'ok') || (r.status === 'running' && now - Date.parse(r.started_at) < RUN_STUCK_MS));
}

/** Is a server-crawled shop also something collectors should leave alone for now? */
function serverFirst(store, since, now) {
  if (!serverStores().includes(store)) return false;
  const serverFailed = runs(store, since).some((r) => r.status === 'error' && r.source === 'server' && (!r.worker || r.worker === 'server'));
  return !serverFailed && now - Date.parse(since) < SERVER_FIRST_MS;
}

/**
 * A collector (worker) asks what to refresh, out of the shops it can do.
 * Returns [{ store, runId, startedAt }], each run already started for it.
 */
export function claim(worker, canDo) {
  const now = clock();
  const since = lastScheduled(now).toISOString();
  const want = shareable().filter((s) => !canDo?.length || canDo.includes(s));
  const out = [];
  for (const store of want) {
    if (doneOrBusy(store, since, now) || serverFirst(store, since, now)) continue;
    if (runs(store, since).some((r) => r.status === 'error' && r.worker === worker.id)) continue; // it already tried today
    const { runId, startedAt } = startRun(store, { source: 'collector' });
    getDb().prepare('UPDATE scrape_runs SET worker = ? WHERE id = ?').run(worker.id, runId);
    out.push({ store, runId, startedAt });
  }
  return out;
}

/** For this server: has a collector already refreshed `store` since the scheduled time, or is it on it? */
export function handledElsewhere(store) {
  const now = clock();
  const since = lastScheduled(now).toISOString();
  return getDb().prepare(`SELECT COUNT(*) n FROM scrape_runs WHERE store = ? AND location IS NULL AND started_at >= ? AND source = 'collector'
    AND (status = 'ok' OR (status = 'running' AND started_at >= ?))`).get(store, since, new Date(now - RUN_STUCK_MS).toISOString()).n > 0;
}
