import * as woolworths from './woolworths.js';
import * as coles from './coles.js';
import * as aldi from './aldi.js';
import * as iga from './iga.js';
import * as harrisfarm from './harrisfarm.js';
import { getDb, upsertProducts, markUnseenUnavailable, nowIso } from '../db.js';
import * as igaStores from '../iga.js';
import { getSetting } from '../settings.js';

export const SCRAPERS = { woolworths, coles, aldi, iga, harrisfarm };

// In-memory status so the UI can show progress of a running scrape.
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
export function finishRun(run, { complete, error = null }) {
  const d = getDb();
  const fresh = getRun(run.id);
  if (error) {
    d.prepare("UPDATE scrape_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?").run(nowIso(), String(error), run.id);
    return fresh;
  }
  if (complete && fresh.products > 0) markUnseenUnavailable(run.store, run.started_at, run.location || null);
  if (run.store === 'iga' && (complete || fresh.products > 0)) igaStores.markScraped(run.location, fresh.products);
  d.prepare("UPDATE scrape_runs SET finished_at = ?, status = 'ok' WHERE id = ?").run(nowIso(), run.id);
  return getRun(run.id);
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
  if (status.running) throw new Error(`${storeName} scrape already running`);

  const { runId, startedAt } = startRun(storeName, { location: opts.location || null });
  const run = getRun(runId);
  Object.assign(status, { running: true, message: 'starting', products: 0, startedAt });
  const log = (msg) => {
    status.message = msg;
    (opts.log || console.log)(msg);
  };

  let products = 0;
  let priceChanges = 0;
  try {
    for await (const batch of scraper.scrape({ ...opts, log })) {
      const r = recordBatch(run, batch);
      products += r.upserted;
      priceChanges += r.priceChanges;
      status.products = products;
    }
    const complete = !opts.onlyCategories?.length && !Number.isFinite(opts.maxPagesPerCategory ?? Infinity);
    finishRun(run, { complete });
    log(`${storeName}: done — ${products} products, ${priceChanges} price changes`);
    return { store: storeName, products, priceChanges };
  } catch (e) {
    finishRun(run, { error: e.message || e });
    log(`${storeName}: failed — ${e.message}`);
    throw e;
  } finally {
    status.running = false;
  }
}

/**
 * Stores this server crawls itself. Stores fed by a home collector (because
 * they block cloud servers) can be left out with SERVER_SCRAPE_STORES.
 */
export function serverStores() {
  const list = (getSetting('SERVER_SCRAPE_STORES') || '').split(',').map((x) => x.trim()).filter((x) => SCRAPERS[x]);
  return list.length ? list : Object.keys(SCRAPERS);
}

// IGA stores are fetched one at a time through a queue (see src/iga.js).
igaStores.setScrapeRunner((location) => scrapeStore('iga', { location }));

/** Every IGA store people use, one after another. */
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
