// Search and cross-store comparison.

import { getDb } from './db.js';
import { STORES } from './stores.js';
import { rankMatches, sameBrand, matchScore, MATCH_THRESHOLD } from './matcher.js';
import { unitPriceFor } from './promos.js';
import { parseSizeFrom, SIZE_TOKEN_RE } from './units.js';
import { sameSizeCandidates, sameWordCandidates } from './match-index.js';
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

export function searchProducts(q, opts = {}) {
  // A size in the search ("coke 1.25l", "rice 5kg") is matched against each
  // product's size rather than its name: most shops don't put it in the name.
  const size = parseSizeFrom(q);
  if (size) {
    const text = String(q).replace(SIZE_TOKEN_RE, ' ');
    const sized = runSearch(text, { ...opts, size });
    // Nothing that size: show the closest thing rather than nothing.
    return sized.length ? sized : runSearch(text, opts);
  }
  return runSearch(q, opts);
}

function runSearch(q, { store, stores, igaStore, limit = 30, offset = 0, specialsOnly = false, size = null } = {}) {
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
  if (size) {
    // Same size within 1%, by either of a product's sizes (e.g. 12 pack / 700g eggs).
    where.push(`((p.size_unit = ? AND abs(p.size_qty - ?) <= ?) OR (p.alt_size_unit = ? AND abs(p.alt_size_qty - ?) <= ?))`);
    const tol = size.qty * 0.01;
    params.push(size.unit, size.qty, tol, size.unit, size.qty, tol);
  }
  const at = loc(igaStore);
  if (!match) {
    return d.prepare(`SELECT ${PRODUCT_COLS} FROM ${FROM_PRICED} WHERE ${where.join(' AND ')}
      ORDER BY on_special DESC, p.name LIMIT ? OFFSET ?`).all(at, ...params, limit, offset);
  }
  const stmt = d.prepare(`SELECT ${PRODUCT_COLS} FROM ${FROM_FTS_PRICED}
    WHERE products_fts MATCH ? AND ${where.join(' AND ')}
    ORDER BY bm25(products_fts, 10.0, 1.0, 8.0) LIMIT ? OFFSET ?`);
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
  const d = getDb();
  // Score names among the products of the same size (an in-memory index), then
  // load just the best of them, priced, from the database.
  const scored = rankMatches(anchor, sameSizeCandidates(anchor), mode).slice(0, 80);
  const scoreOf = new Map(scored.map((m) => [m.product.id, m.score]));
  const candidates = scored.length
    ? d.prepare(`SELECT ${PRODUCT_COLS} FROM ${FROM_PRICED} WHERE p.id IN (SELECT value FROM json_each(?)) AND ${AVAILABLE_SQL}`)
      .all(loc(igaStore), JSON.stringify(scored.map((m) => m.product.id)))
    : [];
  const rules = matchRulesFor(anchor.id);
  let ranked = candidates
    .map((p) => ({ product: p, score: scoreOf.get(p.id) }))
    .sort((x, y) => y.score - x.score || (x.product.price ?? Infinity) - (y.product.price ?? Infinity))
    .filter((m) => {
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

export function cheapestStore(best, memberships = []) {
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
  const allowed = storeSet(stores);
  // The same item in another pack size: same unit, a quarter to four times the size, a matching name.
  const ids = sameWordCandidates(product)
    .filter((c) => allowed.includes(c.store) && c.size_unit === product.size_unit && !c.per_weight
      && c.size_qty >= product.size_qty / 4 && c.size_qty <= product.size_qty * 4
      && Math.abs(c.size_qty - product.size_qty) > product.size_qty * 0.02
      && matchScore(product, c, 'similar', { ignoreSize: true }) >= MATCH_THRESHOLD)
    .slice(0, 200)
    .map((c) => c.id);
  if (!ids.length) return null;
  const candidates = getDb().prepare(`SELECT ${PRODUCT_COLS} FROM ${FROM_PRICED} WHERE p.id IN (SELECT value FROM json_each(?)) AND ${AVAILABLE_SQL}`)
    .all(loc(igaStore), JSON.stringify(ids));
  let best = null;
  for (const c of candidates) {
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
      members: eq.map((m) => ({ ...m.product, score: m.score, via: m.via || null })).sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9)),
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
    equivalents: eq.map((m) => ({ ...m.product, score: m.score, via: m.via || null })),
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

/**
 * A scanned barcode: the product and what it costs at each shop. Barcodes
 * come from Woolworths and Coles, so a match there also finds the same item
 * elsewhere by name and size. Leading zeros are ignored (UPC-A vs EAN-13).
 */
export function lookupBarcode(code, { stores, igaStore, memberships = [] } = {}) {
  const digits = String(code || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14) return null;
  const rows = getDb().prepare(`SELECT id FROM products WHERE barcode IS NOT NULL AND ltrim(barcode, '0') = ltrim(?, '0')
    ORDER BY available DESC LIMIT 5`).all(digits);
  if (!rows.length) return { code: digits, found: false };
  const anchor = getProduct(rows[0].id, igaStore);
  const allowed = storeSet(stores);
  const eq = findEquivalents(anchor, 'similar', igaStore).filter((m) => allowed.includes(m.product.store));
  const best = bestPerStore(eq, memberships);
  return { code: digits, found: true, anchor, best, cheapest: cheapestStore(best, memberships), sameBarcode: rows.map((r) => r.id) };
}
