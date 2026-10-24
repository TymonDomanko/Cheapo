import { SCRAPERS } from './registry.js';
import { getDb, upsertProducts, markUnseenUnavailable, nowIso } from '../db.js';
import * as igaStores from '../iga.js';
import { getSetting } from '../settings.js';
import { checkRun } from '../admin-alerts.js';
import { clearDealsCache } from '../deals.js';

export { SCRAPERS };

// In-memory status so the UI can show progress of a running scrape.
const running = new Set(); // 'coles', 'iga:32600', …
export const scrapeStatus = Object.fromEntries(
  Object.keys(SCRAPERS).map((s) => [s, { running: false, message: 'idle', products: 0, startedAt: null }]),
);

// A "run" is one crawl of one store (one IGA store for IGA). Runs are written
// the same way whether this server crawls the store itself or a home
// collector sends the products in (see src/cli/collect.js).

/** Start a run: returns { runId, startedAt } — startedAt is the run's "seen" time. */
export function startRun(storeName, { location = null, source = 'server' } = {}) {
  if (!SCRAPERS[storeName]) throw Object.assign(new Error(`Unknown store: ${storeName}`), { status: 400 });
  const startedAt = nowIso();
  const runId = getDb()
    .prepare("INSERT INTO scrape_runs (store, location, started_at, status, source) VALUES (?, ?, ?, 'running', ?)")
    .run(storeName, location, startedAt, source).lastInsertRowid;
  return { runId, startedAt };
}

export function getRun(runId) {
  return getDb().prepare('SELECT * FROM scrape_runs WHERE id = ?').get(runId);
}

/** Save one batch of products for a running run. */
export function recordBatch(run, items) {
  if (run.status !== 'running') throw Object.assign(new Error('That run has finished'), { status: 409 });
  const r = upsertProducts(run.store, items, run.started_at, run.location || null);
  getDb().prepare('UPDATE scrape_runs SET products = products + ?, price_changes = price_changes + ? WHERE id = ?')
    .run(r.upserted, r.priceChanges, run.id);
  return r;
}

/**
 * Finish a run. Only a complete crawl can tell us a product has disappeared,
 * so `complete` controls marking unseen products unavailable.
 */
export function finishRun(run, { complete, error = null, seenSince = null }) {
  const d = getDb();
  const fresh = getRun(run.id);
  if (error) {
    d.prepare("UPDATE scrape_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?").run(nowIso(), String(error), run.id);
    checkRun(getRun(run.id)); // emails admins if this needs a look (doesn't wait)
    return fresh;
  }
  if (complete && fresh.products > 0) markUnseenUnavailable(run.store, seenSince || run.started_at, run.location || null);
  if (complete && seenSince) {
    // A crawl spread over several runs: this run finished it, so count everything it found.
    const total = d.prepare('SELECT COUNT(*) n FROM products WHERE store = ? AND last_seen >= ?').get(run.store, seenSince).n;
    d.prepare('UPDATE scrape_runs SET products = ? WHERE id = ?').run(total, run.id);
  }
  if (run.store === 'iga' && (complete || fresh.products > 0)) igaStores.markScraped(run.location, fresh.products);
  d.prepare("UPDATE scrape_runs SET finished_at = ?, status = 'ok' WHERE id = ?").run(nowIso(), run.id);
  const done = getRun(run.id);
  if (complete) checkRun(done);
  clearDealsCache(); // prices changed
  return done;
}

/**
 * Crawl one store and write everything to the database.
 * Stores are independent, so callers can run several of these in parallel.
 * For IGA, opts.location is which IGA store to fetch.
 */
export async function scrapeStore(storeName, opts = {}) {
  const scraper = SCRAPERS[storeName];
  if (!scraper) throw new Error(`Unknown store: ${storeName}`);
  if (storeName === 'iga') opts = { ...opts, location: String(opts.location || igaStores.defaultStoreId()) };
  const status = scrapeStatus[storeName];
  // IGA runs one per store, several at once; other chains one at a time.
  const key = storeName === 'iga' ? `iga:${opts.location}` : storeName;
  if (running.has(key)) throw new Error(`${storeName} scrape already running`);
  running.add(key);

  const { runId, startedAt } = startRun(storeName, { location: opts.location || null });
  const run = getRun(runId);
  Object.assign(status, { running: true, message: 'starting', products: 0, startedAt });
  const log = (msg) => {
    status.message = msg;
    (opts.log || console.log)(msg);
  };

  let products = 0;
  let priceChanges = 0;
  // Where a crawl that was blocked part-way got to, so the next run carries on (Coles).
  const progress = crawlProgress(storeName);
  const result = {};
  try {
    for await (const batch of scraper.scrape({ ...opts, log, progress, result, startedAt })) {
      const r = recordBatch(run, batch);
      products += r.upserted;
      priceChanges += r.priceChanges;
      status.products = products;
    }
    const complete = result.complete ?? (!opts.onlyCategories?.length && !Number.isFinite(opts.maxPagesPerCategory ?? Infinity));
    finishRun(run, { complete, seenSince: result.seenSince });
    log(`${storeName}: done — ${products} products, ${priceChanges} price changes`);
    return { store: storeName, products, priceChanges };
  } catch (e) {
    finishRun(run, { error: e.message || e });
    log(`${storeName}: failed — ${e.message}`);
    if (e.blocked) carryOnLater(storeName, progress);
    throw e;
  } finally {
    running.delete(key);
    status.running = [...running].some((k) => k === storeName || k.startsWith(`${storeName}:`));
  }
}

// A blocked crawl tries again (carrying on where it stopped) a few hours later,
// a few times, rather than waiting for tomorrow's refresh.
const RETRY_HOURS = Number(process.env.BLOCKED_RETRY_HOURS ?? 4);
const MAX_RETRIES = 4;
const retryTimers = {};

function carryOnLater(storeName, progress) {
  const state = progress.load();
  if (!RETRY_HOURS || retryTimers[storeName] || (state?.runs || 0) > MAX_RETRIES) return;
  console.log(`${storeName}: blocked — trying again in ${RETRY_HOURS} hours`);
  const armedAt = nowIso();
  retryTimers[storeName] = setTimeout(() => {
    delete retryTimers[storeName];
    // A collector may have done it meanwhile (see src/claims.js).
    const covered = getDb().prepare(`SELECT COUNT(*) n FROM scrape_runs WHERE store = ? AND source = 'collector'
      AND status IN ('ok', 'running') AND started_at >= ?`).get(storeName, armedAt).n;
    if (!running.has(storeName) && !covered) scrapeStore(storeName).catch(() => {});
  }, RETRY_HOURS * 3600 * 1000);
  retryTimers[storeName].unref?.();
}

/** Where a store's crawl got to, kept between runs. */
export function crawlProgress(storeName) {
  const key = `crawl-progress:${storeName}`;
  const d = getDb();
  return {
    load: () => JSON.parse(d.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || 'null'),
    save: (state) => {
      if (!state) d.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
      else {
        d.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
          .run(key, JSON.stringify(state));
      }
    },
  };
}

/**
 * Stores this server crawls itself. Stores fed by a home collector (because
 * they block cloud servers) can be left out with SERVER_SCRAPE_STORES.
 */
export function serverStores() {
  const list = (getSetting('SERVER_SCRAPE_STORES') || '').split(',').map((x) => x.trim()).filter((x) => SCRAPERS[x]);
  return list.length ? list : Object.keys(SCRAPERS);
}

// IGA stores are fetched through a queue, a few at a time (see src/iga.js).
igaStores.setScrapeRunner((location) => scrapeStore('iga', { location }));

/** Every IGA store people use (a few at a time). */
async function scrapeIga(opts) {
  igaStores.ensureDefaultTracked();
  const ids = igaStores.trackedStores().map((t) => t.store_id);
  // Partial runs (CLI testing) bypass the queue so their options apply.
  if (opts.onlyCategories?.length || Number.isFinite(opts.maxPagesPerCategory ?? Infinity)) {
    const out = [];
    for (const location of ids) out.push(await scrapeStore('iga', { ...opts, location }));
    return out;
  }
  return Promise.all(ids.map((id) => igaStores.requestScrape(id)));
}

/** Scrape several stores in parallel; one store failing doesn't stop the others. */
export async function scrapeAll(stores = Object.keys(SCRAPERS), opts = {}) {
  const results = await Promise.allSettled(stores.map((s) => (s === 'iga' ? scrapeIga(opts) : scrapeStore(s, opts))));
  return results.flatMap((r, i) => {
    if (r.status === 'rejected') return [{ store: stores[i], error: r.reason?.message }];
    return Array.isArray(r.value) ? r.value.map((v) => ({ store: stores[i], ...v })) : [r.value];
  });
}
