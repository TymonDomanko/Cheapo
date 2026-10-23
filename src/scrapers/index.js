import * as woolworths from './woolworths.js';
import * as coles from './coles.js';
import * as aldi from './aldi.js';
import { getDb, upsertProducts, markUnseenUnavailable, nowIso } from '../db.js';

export const SCRAPERS = { woolworths, coles, aldi };

// In-memory status so the UI can show progress of a running scrape.
export const scrapeStatus = Object.fromEntries(
  Object.keys(SCRAPERS).map((s) => [s, { running: false, message: 'idle', products: 0, startedAt: null }]),
);

/**
 * Crawl one store and write everything to the database.
 * Stores are independent, so callers can run several of these in parallel.
 */
export async function scrapeStore(storeName, opts = {}) {
  const scraper = SCRAPERS[storeName];
  if (!scraper) throw new Error(`Unknown store: ${storeName}`);
  const status = scrapeStatus[storeName];
  if (status.running) throw new Error(`${storeName} scrape already running`);

  const db = getDb();
  const startedAt = nowIso();
  const runId = db
    .prepare("INSERT INTO scrape_runs (store, started_at, status) VALUES (?, ?, 'running')")
    .run(storeName, startedAt).lastInsertRowid;
  Object.assign(status, { running: true, message: 'starting', products: 0, startedAt });
  const log = (msg) => {
    status.message = msg;
    (opts.log || console.log)(msg);
  };

  let products = 0;
  let priceChanges = 0;
  try {
    for await (const batch of scraper.scrape({ ...opts, log })) {
      const r = upsertProducts(storeName, batch, startedAt);
      products += r.upserted;
      priceChanges += r.priceChanges;
      status.products = products;
    }
    // Only a full, unrestricted crawl can tell us a product has disappeared.
    const complete = !opts.onlyCategories?.length && !Number.isFinite(opts.maxPagesPerCategory ?? Infinity);
    if (complete && products > 0) markUnseenUnavailable(storeName, startedAt);
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

/** Scrape several stores in parallel; one store failing doesn't stop the others. */
export async function scrapeAll(stores = Object.keys(SCRAPERS), opts = {}) {
  const results = await Promise.allSettled(stores.map((s) => scrapeStore(s, opts)));
  return results.map((r, i) => (r.status === 'fulfilled' ? r.value : { store: stores[i], error: r.reason?.message }));
}
