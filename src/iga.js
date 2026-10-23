// IGA stores are independently owned and price things differently, so people
// pick *their* IGA. We keep IGA's store directory locally, and only collect
// prices for stores someone has picked ("tracked" stores).

import { getDb, nowIso } from './db.js';
import { createClient } from './scrapers/http.js';

const DIRECTORY_URL = 'https://www.igashop.com.au/api/storefront/stores';
const DIRECTORY_MAX_AGE_DAYS = 1;
// How many IGA stores' prices to collect. Unset or 0 = no limit.
const MAX_TRACKED = Number(process.env.IGA_MAX_STORES) > 0 ? Number(process.env.IGA_MAX_STORES) : Infinity;
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

export function defaultStoreId() {
  return process.env.IGA_STORE_ID || '32600';
}

// ---------------------------------------------------------------- directory

let refreshing = null;

/** Make sure the store directory is loaded and not stale. */
export async function ensureDirectory() {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) n, MIN(updated_at) oldest FROM iga_stores').get();
  const stale = !row.n || Date.parse(row.oldest) < Date.now() - DIRECTORY_MAX_AGE_DAYS * 86400000;
  if (!stale) return;
  refreshing ||= refreshDirectory().finally(() => {
    refreshing = null;
  });
  try {
    await refreshing;
  } catch (e) {
    // A stale directory is still usable; an empty one isn't.
    if (!row.n) throw httpError(503, `Couldn’t load the IGA store list: ${e.message}`);
  }
}

async function refreshDirectory() {
  const client = createClient({ origin: 'https://www.igashop.com.au', delayMs: 0 });
  const json = await client.getJson(DIRECTORY_URL);
  const items = json.items || [];
  // An empty or tiny answer is more likely an API hiccup than IGA closing every store.
  if (items.length < 50) throw new Error(`IGA store list looked wrong (${items.length} stores)`);
  saveDirectory(items, { complete: true });
}

/**
 * Store IGA's raw directory entries. With complete: true, stores missing from
 * the list are marked as no longer listed. Exported for tests.
 */
export function saveDirectory(items, { complete = false } = {}) {
  const d = getDb();
  const up = d.prepare(`INSERT INTO iga_stores (id, name, address, suburb, state, postcode, lat, lng, updated_at)
    VALUES (@id, @name, @address, @suburb, @state, @postcode, @lat, @lng, @updated_at)
    ON CONFLICT (id) DO UPDATE SET name=excluded.name, address=excluded.address, suburb=excluded.suburb,
      state=excluded.state, postcode=excluded.postcode, lat=excluded.lat, lng=excluded.lng, listed=1,
      updated_at=excluded.updated_at`);
  const now = nowIso();
  d.transaction(() => {
    if (complete) d.prepare('UPDATE iga_stores SET listed = 0').run();
    for (const s of items) {
      if (s.status && s.status !== 'Active') continue;
      const id = String(s.retailerStoreId || '').trim();
      if (!id || !s.name) continue;
      up.run({
        id,
        name: s.name.trim(),
        address: [s.addressLine1, s.addressLine2].filter(Boolean).join(' ').replace(/,\s*$/, '').trim() || null,
        suburb: s.city || null,
        state: s.countyProvinceState || null,
        postcode: s.postCode || null,
        lat: s.location?.latitude ?? null,
        lng: s.location?.longitude ?? null,
        updated_at: now,
      });
    }
  })();
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = (x) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// The picker only offers stores that publish their prices on igashop.com.au:
// those in IGA's online directory whose latest daily check found prices.
const ONLINE = 'listed = 1 AND no_prices = 0';
const LISTED = `SELECT * FROM iga_stores WHERE ${ONLINE}`;

/** How many IGA stores have prices online (for the picker's explanation). */
export function onlineStoreCount() {
  return getDb().prepare(`SELECT COUNT(*) n FROM iga_stores WHERE ${ONLINE}`).get().n;
}

/** Store row plus whether we have its prices yet. */
function withStatus(s, extra = {}) {
  if (!s) return null;
  const t = getDb().prepare('SELECT last_scraped_at FROM iga_tracked WHERE store_id = ?').get(s.id);
  return {
    id: s.id,
    name: s.name,
    address: s.address,
    suburb: s.suburb,
    state: s.state,
    postcode: s.postcode,
    online: !!s.listed && !s.no_prices,
    tracked: !!t,
    pricesReady: !!t?.last_scraped_at,
    updating: queue.includes(s.id) || current.has(s.id),
    ...extra,
  };
}

export function getStore(id) {
  if (!id) return null;
  return withStatus(getDb().prepare('SELECT * FROM iga_stores WHERE id = ?').get(String(id)));
}

/**
 * Find stores by name / suburb / postcode, or nearest to a point.
 * Text matches are ranked by distance too when a point is given.
 */
export async function searchStores({ q, lat, lng, limit = 8 }) {
  await ensureDirectory();
  const d = getDb();
  const text = String(q || '').trim().toLowerCase();
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng);
  if (!text && !hasPoint) return [];
  let rows = d.prepare(LISTED).all();
  if (text) {
    const words = text.split(/\s+/);
    rows = rows.filter((s) => {
      const hay = `${s.name} ${s.suburb} ${s.postcode} ${s.state} ${s.address}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    // A postcode search should also offer stores in neighbouring postcodes.
    if (/^\d{4}$/.test(text)) {
      const exact = rows;
      const anchor = exact.find((s) => s.lat != null);
      if (anchor) {
        rows = d.prepare(LISTED).all();
        return nearest(rows, anchor.lat, anchor.lng, limit, new Set(exact.map((s) => s.id)));
      }
      if (!exact.length) {
        const near = d.prepare(`${LISTED} AND postcode BETWEEN ? AND ?`).all(
          String(Number(text) - 20).padStart(4, '0'), String(Number(text) + 20).padStart(4, '0'));
        return near.sort((a, b) => Math.abs(a.postcode - text) - Math.abs(b.postcode - text)).slice(0, limit).map((s) => withStatus(s));
      }
    }
  }
  if (hasPoint) return nearest(rows, lat, lng, limit);
  return rows.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit).map((s) => withStatus(s));
}

function nearest(rows, lat, lng, limit, boost = new Set()) {
  return rows
    .filter((s) => s.lat != null)
    .map((s) => ({ s, km: distanceKm(lat, lng, s.lat, s.lng) }))
    .sort((a, b) => (boost.has(b.s.id) - boost.has(a.s.id)) || a.km - b.km)
    .slice(0, limit)
    .map(({ s, km }) => withStatus(s, { distanceKm: Math.round(km * 10) / 10 }));
}

// ---------------------------------------------------------------- daily "who has prices online" check

let checking = null;
export const checkStatus = { running: false, done: 0, total: 0 };

/**
 * Once a day: reload IGA's store directory, then ask each listed store for
 * one product. Stores with products are offered in the picker; stores without
 * are hidden (and re-offered as soon as a later check finds prices again).
 * Followed stores that go offline stop being fetched.
 */
export function checkOnlineStores({ log = console.log, probe = probeStore, loadDirectory = refreshDirectory } = {}) {
  checking ||= runCheck(log, probe, loadDirectory).finally(() => {
    checking = null;
  });
  return checking;
}

async function probeStore(client, id) {
  const count = async (q) => {
    const json = await client.getJson(`https://www.igashop.com.au/api/storefront/stores/${encodeURIComponent(id)}/search?q=${q}&take=1`);
    // An error reply has no total: that's a failed check, not "no products".
    if (typeof json?.total !== 'number') throw new Error('unexpected reply');
    return json.total;
  };
  // Every IGA sells milk and bread. Only call a store offline if both come back empty,
  // because a single empty answer occasionally happens even for stores with prices.
  return (await count('milk')) || (await count('bread'));
}

async function runCheck(log, probe, loadDirectory) {
  const d = getDb();
  const runId = d.prepare('INSERT INTO iga_checks (started_at) VALUES (?)').run(nowIso()).lastInsertRowid;
  Object.assign(checkStatus, { running: true, done: 0, total: 0 });
  try {
    await loadDirectory();
    const stores = d.prepare('SELECT id, no_prices FROM iga_stores WHERE listed = 1').all();
    checkStatus.total = stores.length;
    const client = createClient({ origin: 'https://www.igashop.com.au', delayMs: Number(process.env.IGA_CHECK_DELAY_MS ?? 300) });
    const save = d.prepare('UPDATE iga_stores SET no_prices = ?, online_products = ?, checked_at = ? WHERE id = ?');
    let withPrices = 0;
    let cameOnline = 0;
    let wentOffline = 0;
    let failures = 0;
    for (const s of stores) {
      let count;
      try {
        count = await probe(client, s.id);
      } catch {
        failures++; // leave this store as it was; try again tomorrow
        checkStatus.done++;
        continue;
      }
      const noPrices = count > 0 ? 0 : 1;
      if (noPrices && !s.no_prices) wentOffline++;
      if (!noPrices && s.no_prices) cameOnline++;
      if (!noPrices) withPrices++;
      save.run(noPrices, count, nowIso(), s.id);
      checkStatus.done++;
    }
    // If most probes failed, IGA's API was down: don't trust this run.
    if (failures > stores.length / 2) throw new Error(`${failures} of ${stores.length} store checks failed`);
    // Stop fetching followed stores that no longer publish prices (the default stays, so the site has IGA prices).
    const dropped = d.prepare(`DELETE FROM iga_tracked WHERE store_id != ? AND store_id IN
      (SELECT id FROM iga_stores WHERE listed = 0 OR no_prices = 1)`).run(defaultStoreId()).changes;
    d.prepare(`UPDATE iga_checks SET finished_at = ?, listed = ?, with_prices = ?, came_online = ?, went_offline = ?
      WHERE id = ?`).run(nowIso(), stores.length, withPrices, cameOnline, wentOffline, runId);
    log(`iga check: ${withPrices} of ${stores.length} listed IGAs have prices online`
      + ` (${cameOnline} new, ${wentOffline} gone${dropped ? `, stopped following ${dropped}` : ''})`);
    return { listed: stores.length, withPrices, cameOnline, wentOffline, failures };
  } catch (e) {
    d.prepare('UPDATE iga_checks SET finished_at = ?, error = ? WHERE id = ?').run(nowIso(), e.message, runId);
    log(`iga check failed: ${e.message}`);
    throw e;
  } finally {
    checkStatus.running = false;
  }
}

export function lastCheck() {
  return getDb().prepare('SELECT * FROM iga_checks ORDER BY id DESC LIMIT 1').get() || null;
}

/** True if no check has succeeded in the last day (e.g. the server was off at check time). */
export function checkIsDue() {
  const ok = getDb().prepare('SELECT MAX(finished_at) t FROM iga_checks WHERE error IS NULL AND finished_at IS NOT NULL').get().t;
  return !ok || Date.parse(ok) < Date.now() - 23 * 3600000;
}

// ---------------------------------------------------------------- tracking & fetching prices

export function trackedStores() {
  return getDb().prepare(`SELECT t.*, s.name, s.suburb, s.state FROM iga_tracked t
    LEFT JOIN iga_stores s ON s.id = t.store_id ORDER BY t.added_at`).all();
}

/**
 * Someone picked this store: start collecting its prices if we aren't yet.
 * Validates the id against the directory.
 */
export async function useStore(storeId, userId = null) {
  await ensureDirectory();
  const id = String(storeId || '');
  const known = getDb().prepare('SELECT no_prices, listed FROM iga_stores WHERE id = ?').get(id);
  if (!known) throw httpError(400, 'Unknown IGA store');
  if (known.no_prices || !known.listed) throw httpError(400, 'That IGA doesn’t publish its prices online, so we can’t compare it.');
  const d = getDb();
  if (!d.prepare('SELECT 1 FROM iga_tracked WHERE store_id = ?').get(id)) {
    const n = d.prepare('SELECT COUNT(*) n FROM iga_tracked').get().n;
    if (n >= MAX_TRACKED) {
      throw httpError(409, 'This site has reached its limit of IGA stores it can follow. Pick a store that already has prices, or ask the admin.');
    }
    d.prepare('INSERT INTO iga_tracked (store_id, added_at, added_by) VALUES (?, ?, ?)').run(id, nowIso(), userId);
    requestScrape(id);
  }
  return getStore(id);
}

export function untrack(storeId) {
  if (String(storeId) === defaultStoreId()) throw httpError(400, 'That’s the default IGA store');
  getDb().prepare('DELETE FROM iga_tracked WHERE store_id = ?').run(String(storeId));
}

/**
 * Record a finished fetch. A store whose online catalogue came back empty
 * doesn't really publish prices: hide it from the picker and stop following it.
 */
export function markScraped(storeId, productCount) {
  const d = getDb();
  const id = String(storeId);
  if (productCount > 0) {
    d.prepare('UPDATE iga_tracked SET last_scraped_at = ? WHERE store_id = ?').run(nowIso(), id);
    d.prepare('UPDATE iga_stores SET no_prices = 0 WHERE id = ?').run(id);
  } else {
    d.prepare('UPDATE iga_stores SET no_prices = 1 WHERE id = ?').run(id);
    if (id !== defaultStoreId()) d.prepare('DELETE FROM iga_tracked WHERE store_id = ?').run(id);
  }
}

/** Make sure the site's default IGA store is always followed. */
export function ensureDefaultTracked() {
  getDb().prepare('INSERT OR IGNORE INTO iga_tracked (store_id, added_at) VALUES (?, ?)').run(defaultStoreId(), nowIso());
}

// A few IGA stores are fetched at once (IGA_CONCURRENCY, default 3); newly
// picked stores wait their turn.
const CONCURRENCY = Math.max(1, Number(process.env.IGA_CONCURRENCY) || 3);
const queue = []; // store ids waiting
const waiters = new Map(); // store id → [resolve]
const current = new Set(); // store ids being fetched now
let runner = null; // (storeId) => Promise, set by the scrapers module to avoid an import cycle

export function setScrapeRunner(fn) {
  runner = fn;
}

/** Queue a price fetch for one IGA store. Resolves when that store is done. */
export function requestScrape(storeId) {
  const id = String(storeId);
  if (process.env.DISABLE_BACKGROUND_SCRAPES === 'true' || !runner) return Promise.resolve();
  const done = new Promise((resolve) => waiters.set(id, [...(waiters.get(id) || []), resolve]));
  if (!current.has(id) && !queue.includes(id)) {
    queue.push(id);
    drain();
  }
  return done;
}

function drain() {
  while (current.size < CONCURRENCY && queue.length) {
    const id = queue.shift();
    current.add(id);
    Promise.resolve()
      .then(() => runner(id))
      .catch((e) => {
        console.error(`IGA store ${id}: ${e.message}`);
        return { error: e.message };
      })
      .then((result) => {
        for (const resolve of waiters.get(id) || []) resolve(result);
        waiters.delete(id);
        current.delete(id);
        drain();
      });
  }
}

export function queueStatus() {
  return { current: [...current][0] ?? null, fetching: [...current], waiting: [...queue] };
}
