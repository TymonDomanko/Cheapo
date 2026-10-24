// "What's the cheapest …?" — the answer at the top of a search, regardless of
// brand.
//
// "1l milk": every 1L milk at your shops, cheapest first, with the cheapest at
// each shop. "milk": the common sizes of milk, each with its cheapest, and the
// best value per litre / kg / item highlighted.
//
// "Milk" means plain milk: products whose names add a variant word you didn't
// ask for (lite, lactose free, almond, chocolate…) are left out, and those
// variants are offered as ways to narrow the search instead. Matches from
// other parts of the shop (milk chocolate when you asked for milk) are dropped
// by keeping only the shop section most of the results come from.

import { runSearch, expandQuery } from './compare.js';
import { parseSizeFrom, SIZE_TOKEN_RE, formatSize } from './units.js';
import { nameTokens, tokensOf, VARIANT_WORDS } from './matcher.js';
import { unitPriceFor } from './promos.js';
import { aisleFor } from './aisles.js';
import { catalogueVersion } from './db.js';

const CANDIDATES = 600;
const SIZES_SHOWN = 5;
const PER_SIZE = 3;
const RANKED = 10;
// Grades of the same thing rather than different products: "eggs" includes
// free range, barn and cage eggs (and offers them as choices), but "milk"
// doesn't include oat or lactose-free milk.
const GRADES = new Set(['freerange', 'cage', 'barn']);

// How variant words read as chips, and what a chip adds to the search. Some
// words only make sense with another ("free" in "lactose free"), so no chip.
const VARIANT_LABEL = {
  free: null, low: null, reduced: null, extra: null, half: null, sugar: null, salt: null,
  gluten: 'Gluten free', lactose: 'Lactose free', freerange: 'Free range', longlife: 'Long life', a2: 'A2', uht: 'UHT',
};
const VARIANT_SEARCH = { gluten: 'gluten free', lactose: 'lactose free', freerange: 'free range', longlife: 'long life' };

const UNIT_WORD = { g: 'kg', ml: 'L', ea: 'item' };

// Words that often end a name without being what it is: "Bread Original",
// "Eggs Medium", "Chicken Breast Fillets", "Butter Pat".
const DESCRIPTORS = new Set([
  'original', 'classic', 'regular', 'standard', 'premium', 'family', 'size', 'loose', 'fresh', 'australian', 'variety', 'multi',
  'small', 'medium', 'large', 'jumbo', 'xl', 'prepacked', 'punnet', 'bunch', 'dozen', 'tub', 'pat', 'roll', 'loaf',
  'fillet', 'steak', 'piece', 'portion', 'strip',
]);

/** Price per kg / L / item. */
function perUnit(price, p) {
  if (price == null || !p.size_qty) return null;
  return p.size_unit === 'ea' ? price / p.size_qty : (price / p.size_qty) * 1000;
}

const round2 = (n) => Math.round(n * 100) / 100;
const sizeKey = (p) => (p.per_weight ? `${p.size_unit}:per` : `${p.size_unit}:${Math.round(p.size_qty)}`);
const sizeLabel = (p) => (p.per_weight ? (p.size_unit === 'ea' ? 'each' : 'per kg') : formatSize(p.size_qty, p.size_unit));

// Lists with "add cheapest" items re-run their searches every time they're
// shown, so remember answers until the prices change (or for a minute).
const CACHE_MS = 60 * 1000;
const cache = new Map();

/**
 * @param {string} q the search as typed
 * @param {{stores?: string[], igaStore?: string, memberships?: string[]}} opts
 */
export function bestPrices(q, opts = {}) {
  const key = JSON.stringify([String(q).trim().toLowerCase(), opts.stores || null, opts.igaStore || null, [...(opts.memberships || [])].sort(), catalogueVersion()]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = compute(q, opts);
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function compute(q, { stores, igaStore, memberships = [] } = {}) {
  const asTyped = String(q).trim();
  q = expandQuery(q);
  const size = parseSizeFrom(q);
  const text = size ? String(q).replace(SIZE_TOKEN_RE, ' ') : String(q);
  const wanted = nameTokens(text);
  if (!wanted.size) return null;

  let found = runSearch(text, { stores, igaStore, limit: CANDIDATES, size })
    .filter((p) => p.price != null && p.size_unit && (p.size_qty || p.per_weight));
  if (!found.length) return { query: asTyped, size: size ? formatSize(size.qty, size.unit) : null, groups: [], variants: [] };

  // Every word searched for has to be in the product's own name (not just its
  // shop category: "Dairy, Eggs & Fridge" doesn't make yoghurt eggs).
  const hasWord = (toks, w) => [...toks].some((t) => t === w || t === `${w}s` || w === `${t}s`);
  found = found.filter((p) => {
    const own = nameTokens(p.name, null);
    return [...wanted].every((w) => hasWord(own, w));
  });
  if (!found.length) return { query: asTyped, size: size ? formatSize(size.qty, size.unit) : null, groups: [], variants: [] };

  // Keep the section of the shop most of the best-ranked matches are in. Use
  // the shop's own category where there is one (the name would put Banana
  // Boat sunscreen with the bananas).
  const sectionOf = (p) => (p.category ? aisleFor({ category: p.category }) : aisleFor({ name: p.name }));
  const counts = {};
  for (const p of found.slice(0, 40)) {
    const a = sectionOf(p);
    counts[a] = (counts[a] || 0) + 1;
  }
  const aisle = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  found = found.filter((p) => sectionOf(p) === aisle);

  // Plain versions only, unless there aren't enough of them.
  const extraVariants = (p) => [...tokensOf(p)].filter((t) => VARIANT_WORDS.has(t) && !GRADES.has(t) && !wanted.has(t));
  const otherChoices = (p) => [...tokensOf(p)].filter((t) => VARIANT_WORDS.has(t) && !wanted.has(t));
  const plain = found.filter((p) => !extraVariants(p).length);
  const mixed = !plain.length;
  const variantCounts = {};
  for (const p of found) {
    for (const t of new Set(otherChoices(p))) variantCounts[t] = (variantCounts[t] || 0) + 1;
  }
  const variants = Object.entries(variantCounts)
    .filter(([t, n]) => VARIANT_LABEL[t] !== null && n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t]) => ({ word: VARIANT_SEARCH[t] || t, label: VARIANT_LABEL[t] || t[0].toUpperCase() + t.slice(1) }));
  const pool = mixed ? found : plain;

  const item = (p) => {
    const price = unitPriceFor(p, memberships);
    const pu = perUnit(price, p);
    return {
      id: p.id, store: p.store, name: p.name, brand: p.brand, size_text: p.size_text, image_url: p.image_url,
      price: round2(price), was_price: p.was_price, on_special: p.on_special, promo_text: p.promo_text,
      multi_qty: p.multi_qty, multi_price: p.multi_price, member_price: p.member_price,
      perUnit: pu == null ? null : round2(pu), unitWord: p.per_weight ? (p.size_unit === 'ea' ? 'each' : 'kg') : UNIT_WORD[p.size_unit],
    };
  };

  // Group by pack size, cheapest first in each. A size that was asked for is
  // one group, even when shops measure it differently (12 pack / 700g eggs).
  const bySize = new Map();
  for (const p of pool) {
    const k = size ? 'asked' : sizeKey(p);
    if (!bySize.has(k)) {
      bySize.set(k, size
        ? { key: k, label: formatSize(size.qty, size.unit), unit: size.unit, qty: size.qty, products: [] }
        : { key: k, label: sizeLabel(p), unit: p.size_unit, qty: p.per_weight ? null : p.size_qty, products: [] });
    }
    bySize.get(k).products.push(item(p));
  }
  for (const g of bySize.values()) g.products.sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));

  let groups = [...bySize.values()];
  if (size) {
    // One size asked for: the ranking, and the cheapest at each shop.
    groups = groups.map((g) => {
      const perStore = {};
      for (const p of g.products) if (!perStore[p.store]) perStore[p.store] = p;
      return { ...g, count: g.products.length, products: g.products.slice(0, RANKED), cheapestPerStore: perStore };
    });
  } else {
    // The most common sizes of the thing itself, smallest first, each with its
    // cheapest few. "The thing itself": the word searched for is the product's
    // main noun, near the end of its name ("Free Range Eggs", not "Egg Fettucine").
    // A size counts if the word is the last word of something in it; within a
    // size, products with it among their last two words are kept ("Pasta Penne").
    const endsWith = (p, n) => {
      const toks = [...nameTokens(p.name, null)].filter((t) => !DESCRIPTORS.has(t));
      return toks.slice(-n).some((t) => [...wanted].some((w) => t === w || t === `${w}s` || w === `${t}s`));
    };
    for (const g of groups) {
      g.main = g.products.filter((p) => endsWith(p, 1)).length;
      const loose = g.products.filter((p) => endsWith(p, 2));
      if (loose.length) g.products = loose;
    }
    if (groups.some((g) => g.main)) groups = groups.filter((g) => g.main);
    groups = groups
      .sort((a, b) => b.main - a.main || b.products.length - a.products.length)
      .slice(0, SIZES_SHOWN)
      .sort((a, b) => a.unit.localeCompare(b.unit) || (a.qty ?? Infinity) - (b.qty ?? Infinity))
      .map((g) => ({ ...g, count: g.products.length, products: g.products.slice(0, PER_SIZE) }));
    // Best value per kg / L / item among the sizes measured the same way.
    for (const unit of new Set(groups.map((g) => g.unit))) {
      const same = groups.filter((g) => g.unit === unit && g.products[0]?.perUnit != null);
      if (same.length < 2) continue;
      const best = same.reduce((a, b) => (b.products[0].perUnit < a.products[0].perUnit ? b : a));
      best.bestValue = true;
    }
  }

  return {
    query: asTyped,
    size: size ? formatSize(size.qty, size.unit) : null,
    aisle,
    mixed,
    variants,
    groups,
  };
}
