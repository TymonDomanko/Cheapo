// IGA stores are independently owned and price things differently, so people
// pick *their* IGA. We keep IGA's store directory locally, and only collect
// prices for stores someone has picked ("tracked" stores).

import { getDb, nowIso } from './db.js';
import { createClient } from './scrapers/http.js';

const DIRECTORY_URL = 'https://www.igashop.com.au/api/storefront/stores';
const DIRECTORY_MAX_AGE_DAYS = 7;
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
  saveDirectory(json.items || []);
}

/** Store IGA's raw directory entries. Exported for tests. */
export function saveDirectory(items) {
  const d = getDb();
  const up = d.prepare(`INSERT INTO iga_stores (id, name, address, suburb, state, postcode, lat, lng, updated_at)
    VALUES (@id, @name, @address, @suburb, @state, @postcode, @lat, @lng, @updated_at)
    ON CONFLICT (id) DO UPDATE SET name=excluded.name, address=excluded.address, suburb=excluded.suburb,
      state=excluded.state, postcode=excluded.postcode, lat=excluded.lat, lng=excluded.lng, updated_at=excluded.updated_at`);
  const now = nowIso();
  d.transaction(() => {
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

/** Store row plus whether we have its prices yet. */
// The picker only offers stores that publish their prices on igashop.com.au:
// those in IGA's online directory, minus any whose catalogue turned out empty.
const LISTED = 'SELECT * FROM iga_stores WHERE no_prices = 0';

/** How many IGA stores have prices online (for the picker's explanation). */
export function onlineStoreCount() {
  return getDb().prepare('SELECT COUNT(*) n FROM iga_stores WHERE no_prices = 0').get().n;
}

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
    tracked: !!t,
    pricesReady: !!t?.last_scraped_at,
    updating: queue.includes(s.id) || current === s.id,
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
  const known = getDb().prepare('SELECT no_prices FROM iga_stores WHERE id = ?').get(id);
  if (!known) throw httpError(400, 'Unknown IGA store');
  if (known.no_prices) throw httpError(400, 'That IGA doesn’t publish its prices online, so we can’t compare it.');
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

// One IGA store is fetched at a time; newly picked stores wait their turn.
const queue = []; // store ids waiting
const waiters = new Map(); // store id → [resolve]
let current = null;
let runner = null; // (storeId) => Promise, set by the scrapers module to avoid an import cycle

export function setScrapeRunner(fn) {
  runner = fn;
}

/** Queue a price fetch for one IGA store. Resolves when that store is done. */
export function requestScrape(storeId) {
  const id = String(storeId);
  if (process.env.DISABLE_BACKGROUND_SCRAPES === 'true' || !runner) return Promise.resolve();
  const done = new Promise((resolve) => waiters.set(id, [...(waiters.get(id) || []), resolve]));
  if (current !== id && !queue.includes(id)) {
    queue.push(id);
    drain();
  }
  return done;
}

async function drain() {
  if (current) return;
  while (queue.length) {
    current = queue.shift();
    let result;
    try {
      result = await runner(current);
    } catch (e) {
      result = { error: e.message };
      console.error(`IGA store ${current}: ${e.message}`);
    }
    for (const resolve of waiters.get(current) || []) resolve(result);
    waiters.delete(current);
    current = null;
  }
}

export function queueStatus() {
  return { current, waiting: [...queue] };
}
