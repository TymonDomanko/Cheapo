// Search, cross-store comparison and shopping-list resolution.

import { getDb, STORES, nowIso } from './db.js';
import { nameTokens, rankMatches, matchScore } from './matcher.js';

const PRODUCT_COLS = `p.id, p.store, p.store_product_id, p.name, p.brand, p.size_text, p.size_qty, p.size_unit,
  p.alt_size_qty, p.alt_size_unit,
  p.per_weight, p.category, p.image_url, p.product_url, p.price, p.was_price, p.unit_price, p.unit_price_text,
  p.on_special, p.available, p.first_seen, p.last_seen`;

function ftsQuery(text, op = 'AND', prefixLast = op === 'AND') {
  const toks = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!toks.length) return null;
  // Prefix-match the last word so results appear while typing.
  return toks.map((t, i) => (i === toks.length - 1 && prefixLast ? `"${t}"*` : `"${t}"`)).join(` ${op} `);
}

export function getProduct(id) {
  return getDb().prepare(`SELECT ${PRODUCT_COLS} FROM products p WHERE p.id = ?`).get(id);
}

export function searchProducts(q, { store, limit = 30, offset = 0, specialsOnly = false } = {}) {
  const d = getDb();
  const match = ftsQuery(q);
  const where = ['p.available = 1'];
  const params = [];
  if (store && STORES.includes(store)) {
    where.push('p.store = ?');
    params.push(store);
  }
  if (specialsOnly) where.push('p.on_special = 1');
  if (!match) {
    return d.prepare(`SELECT ${PRODUCT_COLS} FROM products p WHERE ${where.join(' AND ')}
      ORDER BY p.on_special DESC, p.name LIMIT ? OFFSET ?`).all(...params, limit, offset);
  }
  const stmt = d.prepare(`SELECT ${PRODUCT_COLS} FROM products_fts f JOIN products p ON p.id = f.rowid
    WHERE products_fts MATCH ? AND ${where.join(' AND ')}
    ORDER BY bm25(products_fts, 10.0, 3.0, 1.0) LIMIT ? OFFSET ?`);
  // Whole-word matches first, then prefix matches ("egg" → "eggplant") to fill up.
  const exact = stmt.all(ftsQuery(q, 'AND', false), ...params, limit, offset);
  if (exact.length >= limit) return exact;
  const ids = new Set(exact.map((p) => p.id));
  const prefix = stmt.all(match, ...params, limit, offset).filter((p) => !ids.has(p.id));
  return [...exact, ...prefix].slice(0, limit);
}

/**
 * Every available product (any store, including the anchor's own) that counts
 * as the same item as `anchor`: same pack size and a similar name.
 * @param {'similar'|'exact'|'this'} mode
 */
export function findEquivalents(anchor, mode = 'similar') {
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
    candidates = d.prepare(`SELECT ${PRODUCT_COLS} FROM products_fts f JOIN products p ON p.id = f.rowid
      WHERE products_fts MATCH ? AND p.available = 1 AND (${conds.join(' OR ')})
      ORDER BY rank LIMIT 400`).all(ftsQuery(toks.join(' '), 'OR'), ...params);
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
  const results = searchProducts(q, { ...opts, limit: opts.limit ?? 30 });
  const seen = new Set();
  const groups = [];
  for (const p of results) {
    if (seen.has(p.id)) continue;
    const eq = findEquivalents(p, opts.mode || 'similar');
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

export function priceHistory(productIds) {
  if (!productIds.length) return [];
  const d = getDb();
  const ph = productIds.map(() => '?').join(',');
  return d.prepare(`SELECT product_id, price, was_price, on_special, recorded_at FROM price_history
    WHERE product_id IN (${ph}) ORDER BY recorded_at, id`).all(...productIds);
}

/** Product detail: itself, its cross-store equivalents and everyone's price history. */
export function productDetail(id) {
  const p = getProduct(id);
  if (!p) return null;
  const eq = findEquivalents(p, 'similar');
  const best = bestPerStore(eq);
  // Chart the product itself plus the best match at each other store.
  const charted = [p, ...Object.values(best).map((m) => m.product).filter((x) => x.id !== p.id)];
  const history = priceHistory(charted.map((x) => x.id));
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

// ---------------------------------------------------------------- shopping list

export function addToList(productId, quantity = 1, matchMode = 'similar') {
  const d = getDb();
  const existing = d.prepare('SELECT id, quantity FROM shopping_list WHERE product_id = ?').get(productId);
  if (existing) {
    d.prepare('UPDATE shopping_list SET quantity = quantity + ? WHERE id = ?').run(quantity, existing.id);
    return existing.id;
  }
  return d.prepare('INSERT INTO shopping_list (product_id, quantity, match_mode, added_at) VALUES (?, ?, ?, ?)')
    .run(productId, quantity, matchMode, nowIso()).lastInsertRowid;
}

export function updateListItem(id, { quantity, matchMode }) {
  const d = getDb();
  if (quantity != null) d.prepare('UPDATE shopping_list SET quantity = ? WHERE id = ?').run(Math.max(1, quantity | 0), id);
  if (matchMode) d.prepare('UPDATE shopping_list SET match_mode = ? WHERE id = ?').run(matchMode, id);
}

export function removeListItem(id) {
  getDb().prepare('DELETE FROM shopping_list WHERE id = ?').run(id);
}

export function clearList() {
  getDb().prepare('DELETE FROM shopping_list').run();
}

/** @param {number|null|'auto'} productId  'auto' clears the override, null excludes the store. */
export function setOverride(listItemId, store, productId) {
  const d = getDb();
  if (productId === 'auto') {
    d.prepare('DELETE FROM list_overrides WHERE list_item_id = ? AND store = ?').run(listItemId, store);
  } else {
    d.prepare(`INSERT INTO list_overrides (list_item_id, store, product_id) VALUES (?, ?, ?)
      ON CONFLICT (list_item_id, store) DO UPDATE SET product_id = excluded.product_id`)
      .run(listItemId, store, productId);
  }
}

/** Work out, for every list item, what to buy at each store and where it's cheapest. */
export function resolveList(stores = STORES) {
  const d = getDb();
  const items = d.prepare('SELECT * FROM shopping_list ORDER BY added_at, id').all();
  const overrides = d.prepare('SELECT * FROM list_overrides').all();
  return items.map((item) => {
    const anchor = getProduct(item.product_id);
    const eq = findEquivalents(anchor, item.match_mode);
    const best = bestPerStore(eq);
    const perStore = {};
    for (const s of STORES) {
      const ov = overrides.find((o) => o.list_item_id === item.id && o.store === s);
      const candidates = eq.filter((m) => m.product.store === s).slice(0, 10)
        .map((m) => ({ ...m.product, score: m.score }));
      if (ov && ov.product_id == null) {
        perStore[s] = { excluded: true, candidates };
      } else if (ov) {
        const p = getProduct(ov.product_id);
        perStore[s] = p ? { product: p, manual: true, score: matchScore(anchor, p), candidates } : { candidates };
      } else {
        perStore[s] = best[s] ? { product: best[s].product, score: best[s].score, candidates } : { candidates };
      }
    }
    let cheapest = null;
    for (const s of stores) {
      const ps = perStore[s];
      if (!ps?.product || ps.excluded || !ps.product.available || ps.product.price == null) continue;
      if (!cheapest || ps.product.price < perStore[cheapest].product.price) cheapest = s;
    }
    return { id: item.id, quantity: item.quantity, matchMode: item.match_mode, anchor, perStore, cheapest };
  });
}

/**
 * Split the list across stores so every item is bought where it's cheapest.
 * Also reports what the whole list would cost at each single store.
 */
export function orderPlan(stores = STORES) {
  const items = resolveList(stores);
  const byStore = Object.fromEntries(stores.map((s) => [s, { items: [], total: 0 }]));
  const unavailable = [];
  for (const it of items) {
    if (!it.cheapest) {
      unavailable.push({ id: it.id, name: it.anchor.name });
      continue;
    }
    const p = it.perStore[it.cheapest].product;
    const line = round2(p.price * it.quantity);
    byStore[it.cheapest].items.push({ listItemId: it.id, quantity: it.quantity, product: p, lineTotal: line });
    byStore[it.cheapest].total = round2(byStore[it.cheapest].total + line);
  }
  const total = round2(Object.values(byStore).reduce((n, s) => n + s.total, 0));
  const singleStore = Object.fromEntries(stores.map((s) => {
    let sum = 0;
    let missing = 0;
    for (const it of items) {
      const p = it.perStore[s]?.product;
      if (p && !it.perStore[s].excluded && p.available && p.price != null) sum += p.price * it.quantity;
      else missing++;
    }
    return [s, { total: round2(sum), missing }];
  }));
  return { stores, byStore, total, unavailable, singleStore, itemCount: items.length };
}

const round2 = (n) => Math.round(n * 100) / 100;
