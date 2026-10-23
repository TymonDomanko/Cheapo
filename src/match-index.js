// Fast lookup of "same pack size" products for matching across shops.
//
// Products only count as the same item when their pack sizes agree, so the
// candidates for a match are the products of that size — a few hundred or
// thousand out of tens of thousands. This keeps every available product's
// sizes and name in memory, bucketed by size, and is rebuilt when the
// catalogue changes (at most every 30 seconds during a refresh, since a
// rebuild takes a moment on a full catalogue).

import { getDb, catalogueVersion } from './db.js';
import { tokensOf } from './matcher.js';

const REBUILD_EVERY_MS = 30 * 1000;
const SMALL = 20000; // small catalogues (tests, demo) rebuild straight away
let index = null;

const keyOf = (unit, qty) => `${unit}:${Math.round(qty)}`;

function build() {
  const rows = getDb().prepare(`SELECT id, store, name, brand, barcode, size_qty, size_unit, alt_size_qty, alt_size_unit, per_weight
    FROM products WHERE available = 1 AND (size_unit IS NOT NULL OR alt_size_unit IS NOT NULL)`).all();
  const buckets = new Map();
  const add = (unit, qty, row) => {
    if (!unit || !(qty > 0)) return;
    const k = keyOf(unit, qty);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(row);
  };
  for (const r of rows) {
    add(r.size_unit, r.size_qty, r);
    add(r.alt_size_unit, r.alt_size_qty, r);
  }
  return { version: catalogueVersion(), builtAt: Date.now(), size: rows.length, buckets, words: null, rows };
}

/** Word -> products with that word in their name (built the first time it's needed). */
function words(ix) {
  if (ix.words) return ix.words;
  ix.words = new Map();
  for (const r of ix.rows) {
    for (const t of tokensOf(r)) {
      if (!ix.words.has(t)) ix.words.set(t, []);
      ix.words.get(t).push(r);
    }
  }
  return ix.words;
}

/**
 * Products sharing one of the anchor's three rarest name words, in any size —
 * a real match shares most of its words, so it will share one of these.
 */
export function sameWordCandidates(anchor) {
  const w = words(current());
  const toks = [...tokensOf(anchor)]
    .map((t) => w.get(t) || [])
    .sort((a, b) => a.length - b.length)
    .slice(0, 3);
  const seen = new Set();
  const out = [];
  for (const list of toks) {
    for (const r of list) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

function current() {
  const stale = index && index.version !== catalogueVersion();
  const age = index ? Date.now() - index.builtAt : Infinity;
  // Also rebuild now and then regardless: a separate `npm run scrape` changes the database without telling us.
  if ((stale && (index.size < SMALL || age > REBUILD_EVERY_MS)) || age > 15 * 60 * 1000) index = build();
  return index;
}

/**
 * Products of roughly the same size as `anchor`, by either of its sizes (the
 * exact 1% check happens when they're scored). Each is a light row: id, store,
 * name, brand, barcode and sizes.
 */
export function sameSizeCandidates(anchor) {
  const { buckets } = current();
  const seen = new Set();
  const out = [];
  for (const [unit, qty] of [[anchor.size_unit, anchor.size_qty], [anchor.alt_size_unit, anchor.alt_size_qty]]) {
    if (!unit || !(qty > 0)) continue;
    for (let q = Math.floor(qty * 0.99); q <= Math.ceil(qty * 1.01); q++) {
      for (const r of buckets.get(keyOf(unit, q)) || []) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
    }
  }
  return out;
}

/** Build the indexes ahead of time (after the server starts), so the first search doesn't wait. */
export function warmUp() {
  words(current());
}
