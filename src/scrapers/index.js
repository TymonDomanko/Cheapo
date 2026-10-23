import * as woolworths from './woolworths.js';
import * as coles from './coles.js';
import * as aldi from './aldi.js';
import * as iga from './iga.js';
import * as harrisfarm from './harrisfarm.js';
import { getDb, upsertProducts, markUnseenUnavailable, nowIso } from '../db.js';
import * as igaStores from '../iga.js';

export const SCRAPERS = { woolworths, coles, aldi, iga, harrisfarm };

// In-memory status so the UI can show progress of a running scrape.
export const scrapeStatus = Object.fromEntries(
  Object.keys(SCRAPERS).map((s) => [s, { running: false, message: 'idle', products: 0, startedAt: null }]),
);

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

  const db = getDb();
  const startedAt = nowIso();
  const runId = db
    .prepare("INSERT INTO scrape_runs (store, location, started_at, status) VALUES (?, ?, ?, 'running')")
    .run(storeName, opts.location || null, startedAt).lastInsertRowid;
  Object.assign(status, { running: true, message: 'starting', products: 0, startedAt });
  const log = (msg) => {
    status.message = msg;
    (opts.log || console.log)(msg);
  };

  let products = 0;
  let priceChanges = 0;
  try {
    for await (const batch of scraper.scrape({ ...opts, log })) {
      const r = upsertProducts(storeName, batch, startedAt, opts.location || null);
      products += r.upserted;
      priceChanges += r.priceChanges;
      status.products = products;
    }
    // Only a full, unrestricted crawl can tell us a product has disappeared.
    const complete = !opts.onlyCategories?.length && !Number.isFinite(opts.maxPagesPerCategory ?? Infinity);
    if (complete && products > 0) markUnseenUnavailable(storeName, startedAt, opts.location || null);
    if (storeName === 'iga' && (complete || products > 0)) igaStores.markScraped(opts.location, products);
    db.prepare("UPDATE scrape_runs SET finished_at=?, status='ok', products=?, price_changes=? WHERE id=?")
      .run(nowIso(), products, priceChanges, runId);
    log(`${storeName}: done — ${products} products, ${priceChanges} price changes`);
    return { store: storeName, products, priceChanges };
  } catch (e) {
    db.prepare("UPDATE scrape_runs SET finished_at=?, status='error', products=?, price_changes=?, error=? WHERE id=?")
      .run(nowIso(), products, priceChanges, String(e.message || e), runId);
    log(`${storeName}: failed — ${e.message}`);
    throw e;
  } finally {
    status.running = false;
  }
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
