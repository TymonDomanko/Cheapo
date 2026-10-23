// Search and cross-store comparison.

import { getDb } from './db.js';
import { STORES } from './stores.js';
import { nameTokens, rankMatches } from './matcher.js';
import { defaultStoreId } from './iga.js';

// Chains where each store sets its own prices (IGA) keep one shared catalogue
// row per product and each store's price in store_prices. Every product query
// joins in the price for the IGA store being looked at (first SQL parameter).
const PRICE_JOIN = 'LEFT JOIN store_prices sp ON p.location_priced = 1 AND sp.product_id = p.id AND sp.location = ?';
const FROM_PRICED = `products p ${PRICE_JOIN}`;
const FROM_FTS_PRICED = `products_fts f JOIN products p ON p.id = f.rowid ${PRICE_JOIN}`;
const priced = (col, fallback = 'NULL') =>
  `CASE WHEN p.location_priced = 1 THEN COALESCE(sp.${col}, ${fallback}) ELSE p.${col} END`;
const PRODUCT_COLS = `p.id, p.store, p.store_product_id, p.name, p.brand, p.size_text, p.size_qty, p.size_unit,
  p.alt_size_qty, p.alt_size_unit, p.per_weight, p.category, p.image_url, p.product_url,
  ${priced('price')} AS price, ${priced('was_price')} AS was_price, ${priced('unit_price')} AS unit_price,
  ${priced('unit_price_text')} AS unit_price_text, ${priced('on_special', 0)} AS on_special,
  ${priced('available', 0)} AS available, p.first_seen, p.last_seen, sp.location AS location`;
const AVAILABLE_SQL = `${priced('available', 0)} = 1`;
const loc = (igaStore) => String(igaStore || defaultStoreId());

function ftsQuery(text, op = 'AND', prefixLast = op === 'AND') {
  const toks = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!toks.length) return null;
  // Prefix-match the last word so results appear while typing.
  return toks.map((t, i) => (i === toks.length - 1 && prefixLast ? `"${t}"*` : `"${t}"`)).join(` ${op} `);
}

/** A product, priced at the given IGA store (for IGA products). */
export function getProduct(id, igaStore = null) {
  return getDb().prepare(`SELECT ${PRODUCT_COLS} FROM ${FROM_PRICED} WHERE p.id = ?`).get(loc(igaStore), id);
}

/** Only keep known store ids; an empty or missing list means every store. */
function storeSet(stores) {
  const s = (stores || []).filter((x) => STORES.includes(x));
  return s.length ? s : STORES;
}

export function searchProducts(q, { store, stores, igaStore, limit = 30, offset = 0, specialsOnly = false } = {}) {
  const d = getDb();
  const match = ftsQuery(q);
  const where = [AVAILABLE_SQL];
  const params = [];
  const allowed = store && STORES.includes(store) ? [store] : storeSet(stores);
  if (allowed.length < STORES.length) {
    where.push(`p.store IN (${allowed.map(() => '?').join(',')})`);
    params.push(...allowed);
  }
  if (specialsOnly) where.push(`${priced('on_special', 0)} = 1`);
  const at = loc(igaStore);
  if (!match) {
    return d.prepare(`SELECT ${PRODUCT_COLS} FROM ${FROM_PRICED} WHERE ${where.join(' AND ')}
      ORDER BY on_special DESC, p.name LIMIT ? OFFSET ?`).all(at, ...params, limit, offset);
  }
  const stmt = d.prepare(`SELECT ${PRODUCT_COLS} FROM ${FROM_FTS_PRICED}
    WHERE products_fts MATCH ? AND ${where.join(' AND ')}
    ORDER BY bm25(products_fts, 10.0, 3.0, 1.0) LIMIT ? OFFSET ?`);
  // Whole-word matches first, then prefix matches ("egg" → "eggplant") to fill up.
  const exact = stmt.all(at, ftsQuery(q, 'AND', false), ...params, limit, offset);
  if (exact.length >= limit) return exact;
  const ids = new Set(exact.map((p) => p.id));
  const prefix = stmt.all(at, match, ...params, limit, offset).filter((p) => !ids.has(p.id));
  return [...exact, ...prefix].slice(0, limit);
}

/**
 * Every available product (any store, including the anchor's own) that counts
 * as the same item as `anchor`: same pack size and a similar name.
 * @param {'similar'|'exact'|'this'} mode
 */
export function findEquivalents(anchor, mode = 'similar', igaStore = null) {
  if (mode === 'this') return [{ product: anchor, score: 1 }];
  const toks = [...nameTokens(anchor.name, anchor.brand)];
  const d = getDb();
  let candidates = [];
  const sizes = [[anchor.size_unit, anchor.size_qty], [anchor.alt_size_unit, anchor.alt_size_qty]].filter(([u]) => u);
  if (sizes.length && toks.length) {
    // A candidate qualifies if either of its sizes equals either of the anchor's.
    const conds = [];
    const params = [];
    for (const [unit, qty] of sizes) {
      const tol = qty * 0.01;
      for (const col of ['', 'alt_']) {
        conds.push(`(p.${col}size_unit = ? AND p.${col}size_qty BETWEEN ? AND ?)`);
        params.push(unit, qty - tol, qty + tol);
      }
    }
    candidates = d.prepare(`SELECT ${PRODUCT_COLS} FROM ${FROM_FTS_PRICED}
      WHERE products_fts MATCH ? AND ${AVAILABLE_SQL} AND (${conds.join(' OR ')})
      ORDER BY rank LIMIT 400`).all(loc(igaStore), ftsQuery(toks.join(' '), 'OR'), ...params);
  }
  const ranked = rankMatches(anchor, candidates, mode);
  if (!ranked.some((m) => m.product.id === anchor.id)) ranked.unshift({ product: anchor, score: 1 });
  return ranked;
}

/** Cheapest equivalent per store, e.g. { coles: {product, score}, aldi: {...} }. */
export function bestPerStore(equivalents) {
  const best = {};
  for (const m of equivalents) {
    const p = m.product;
    if (p.price == null || !p.available) continue;
    const cur = best[p.store];
    if (!cur || p.price < cur.product.price) best[p.store] = m;
  }
  return best;
}

function cheapestStore(best, stores = STORES) {
  let out = null;
  for (const s of stores) {
    if (best[s] && (!out || best[s].product.price < best[out].product.price)) out = s;
  }
  return out;
}

/**
 * Search, then fold the results into comparison groups: one row per distinct
 * item with the cheapest equivalent at each store.
 */
export function compareSearch(q, opts = {}) {
  const stores = storeSet(opts.stores);
  const results = searchProducts(q, { ...opts, limit: opts.limit ?? 30 });
  const seen = new Set();
  const groups = [];
  for (const p of results) {
    if (seen.has(p.id)) continue;
    const eq = findEquivalents(p, opts.mode || 'similar', opts.igaStore).filter((m) => stores.includes(m.product.store));
    for (const m of eq) seen.add(m.product.id);
    const best = bestPerStore(eq);
    groups.push({
      anchor: p,
      best,
      cheapest: cheapestStore(best),
      members: eq.map((m) => ({ ...m.product, score: m.score })).sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9)),
    });
  }
  return groups;
}

/** Price changes over time; IGA products' history is for the given IGA store. */
export function priceHistory(productIds, igaStore = null) {
  if (!productIds.length) return [];
  const d = getDb();
  const ph = productIds.map(() => '?').join(',');
  return d.prepare(`SELECT product_id, price, was_price, on_special, recorded_at FROM price_history
    WHERE product_id IN (${ph}) AND (location IS NULL OR location = ?) ORDER BY recorded_at, id`)
    .all(...productIds, loc(igaStore));
}

/** Product detail: itself, its cross-store equivalents and everyone's price history. */
export function productDetail(id, stores, igaStore) {
  const p = getProduct(id, igaStore);
  if (!p) return null;
  const allowed = storeSet(stores);
  const eq = findEquivalents(p, 'similar', igaStore).filter((m) => m.product.id === p.id || allowed.includes(m.product.store));
  const best = bestPerStore(eq);
  // Chart the product itself plus the best match at each other store.
  const charted = [p, ...Object.values(best).map((m) => m.product).filter((x) => x.id !== p.id)];
  const history = priceHistory(charted.map((x) => x.id), igaStore);
  return {
    product: p,
    equivalents: eq.map((m) => ({ ...m.product, score: m.score })),
    best,
    charted,
    history,
    stats: historyStats(history.filter((h) => h.product_id === p.id), p.price),
  };
}

function historyStats(rows, current) {
  if (!rows.length) return null;
  const prices = rows.map((r) => r.price);
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
    changes: rows.length - 1,
    since: rows[0].recorded_at,
    current,
  };
}
