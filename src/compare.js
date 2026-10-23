// Search and cross-store comparison.

import { getDb } from './db.js';
import { STORES } from './stores.js';
import { nameTokens, rankMatches, sameBrand, matchScore, MATCH_THRESHOLD } from './matcher.js';
import { unitPriceFor } from './promos.js';
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
  ${priced('available', 0)} AS available, ${priced('promo_text')} AS promo_text, ${priced('multi_qty')} AS multi_qty,
  ${priced('multi_price')} AS multi_price, ${priced('member_price')} AS member_price, p.barcode,
  p.first_seen, p.last_seen, sp.location AS location`;
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
  const rules = matchRulesFor(anchor.id);
  let ranked = rankMatches(anchor, candidates, mode).filter((m) => {
    const p = m.product;
    if (rules.never.has(p.id)) return false;
    // Same brand and size but a different barcode: a different variant the name didn't reveal.
    if (anchor.barcode && p.barcode && anchor.barcode !== p.barcode && sameBrand(anchor, p)) return false;
    return true;
  });
  // Exact matches the name rules can't see: same barcode, or confirmed by an admin.
  const sure = [];
  if (anchor.barcode) {
    sure.push(...d.prepare(`SELECT ${PRODUCT_COLS} FROM ${FROM_PRICED} WHERE p.barcode = ? AND p.id != ? AND ${AVAILABLE_SQL}`)
      .all(loc(igaStore), anchor.barcode, anchor.id).map((p) => ({ product: p, score: 1, via: 'barcode' })));
  }
  for (const pid of rules.always) {
    const p = getProduct(pid, igaStore);
    if (p?.available && (mode !== 'exact' || sameBrand(anchor, p))) sure.push({ product: p, score: 1, via: 'confirmed' });
  }
  if (sure.length) {
    const ids = new Set(sure.map((m) => m.product.id));
    ranked = [...sure.filter((m) => !rules.never.has(m.product.id)), ...ranked.filter((m) => !ids.has(m.product.id))];
  }
  if (!ranked.some((m) => m.product.id === anchor.id)) ranked.unshift({ product: anchor, score: 1 });
  return ranked;
}

/** Admin-confirmed fixes involving this product: ids that are never / always the same item. */
export function matchRulesFor(productId) {
  const rows = getDb().prepare('SELECT a_id, b_id, kind FROM match_rules WHERE a_id = ? OR b_id = ?').all(productId, productId);
  const out = { never: new Set(), always: new Set() };
  for (const r of rows) out[r.kind].add(r.a_id === productId ? r.b_id : r.a_id);
  return out;
}

/** Cheapest equivalent per store, e.g. { coles: {product, score}, aldi: {...} }. */
export function bestPerStore(equivalents, memberships = []) {
  const best = {};
  for (const m of equivalents) {
    const p = m.product;
    if (p.price == null || !p.available) continue;
    const cur = best[p.store];
    if (!cur || unitPriceFor(p, memberships) < unitPriceFor(cur.product, memberships)) best[p.store] = m;
  }
  return best;
}

function cheapestStore(best, memberships = []) {
  let out = null;
  for (const s of STORES) {
    if (best[s] && (!out || unitPriceFor(best[s].product, memberships) < unitPriceFor(best[out].product, memberships))) out = s;
  }
  return out;
}

const UNIT_WORD = { g: 'kg', ml: 'L', ea: 'item' };
const perUnit = (p, memberships) => {
  const price = unitPriceFor(p, memberships);
  if (price == null || !p.size_qty) return null;
  // Price per kg / per litre / per item.
  return p.size_unit === 'ea' ? price / p.size_qty : (price / p.size_qty) * 1000;
};

/**
 * The same item in a different pack size that works out cheaper per kg,
 * litre or item (by at least 10%), at the given stores. Strict matching never
 * mixes sizes; this is a separate, clearly labelled hint.
 */
export function betterValue(product, { igaStore = null, stores = STORES, memberships = [] } = {}) {
  if (!product?.size_unit || product.per_weight) return null;
  const base = perUnit(product, memberships);
  if (!base) return null;
  const toks = [...nameTokens(product.name, product.brand)];
  if (!toks.length) return null;
  const allowed = storeSet(stores);
  const candidates = getDb().prepare(`SELECT ${PRODUCT_COLS} FROM ${FROM_FTS_PRICED}
      WHERE products_fts MATCH ? AND ${AVAILABLE_SQL} AND p.size_unit = ? AND p.per_weight = 0
        AND p.size_qty BETWEEN ? AND ? AND ABS(p.size_qty - ?) > ? * 0.02
      ORDER BY rank LIMIT 300`)
    .all(loc(igaStore), ftsQuery(toks.join(' '), 'OR'), product.size_unit, product.size_qty / 4, product.size_qty * 4,
      product.size_qty, product.size_qty);
  let best = null;
  for (const c of candidates) {
    if (!allowed.includes(c.store)) continue;
    if (matchScore(product, c, 'similar', { ignoreSize: true }) < MATCH_THRESHOLD) continue;
    const pu = perUnit(c, memberships);
    if (pu && pu < base * 0.9 && (!best || pu < best.perUnit)) best = { product: c, perUnit: pu };
  }
  if (!best) return null;
  return {
    product: best.product,
    savingPct: Math.round((1 - best.perUnit / base) * 100),
    perUnit: Math.round(best.perUnit * 100) / 100,
    basePerUnit: Math.round(base * 100) / 100,
    unit: UNIT_WORD[product.size_unit],
  };
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
    const best = bestPerStore(eq, opts.memberships);
    const cheapest = cheapestStore(best, opts.memberships);
    groups.push({
      anchor: p,
      best,
      cheapest,
      betterValue: cheapest ? betterValue(best[cheapest].product, { igaStore: opts.igaStore, stores, memberships: opts.memberships }) : null,
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
