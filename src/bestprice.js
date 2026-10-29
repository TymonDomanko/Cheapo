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
import { nameTokens, tokensOf, VARIANT_WORDS, namedFor, sameWord } from './matcher.js';
import { unitPriceFor } from './promos.js';
import { aisleFor } from './aisles.js';
import { catalogueVersion } from './db.js';
import { breadQuery, breadType, breadGrain, BREAD_GRAINS, TYPE_ORDER, TYPE_SEARCH, typeLabel } from './bread.js';
import { pickleQuery, pickleType, PICKLE_TYPES } from './pickles.js';

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

/** The shop's own category where there is one (the name would put Banana Boat sunscreen with the bananas). */
const sectionOf = (p) => (p.category ? aisleFor({ category: p.category }) : aisleFor({ name: p.name }));

/**
 * The section of the shop most of the best-ranked matches are in, counting
 * products that are the thing searched for ("Bananas", not "Banana Bread")
 * when there are any.
 */
function mainSection(found, wanted) {
  const top = found.slice(0, 60);
  const named = top.filter((p) => namedFor(p, wanted, 1));
  const counts = {};
  for (const p of named.length ? named : top) {
    const a = sectionOf(p);
    counts[a] = (counts[a] || 0) + 1;
  }
  // A plain fruit or veg name means the fresh one ("tomatoes", not tinned), if there's a fair choice of fresh.
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (named.length && (counts.produce || 0) >= Math.max(3, total / 4)) return 'produce';
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Fruit and veg: one group by the kilo (loose, bagged, or sold each with a
 * weight, like Coles' "approx. 170g" banana) and one by the item, each
 * cheapest first by price per kg / per item.
 */
function produceGroups(pool, wanted, item) {
  const things = pool.filter((p) => namedFor(p, wanted, 1));
  const groups = [
    { key: 'g:per', label: 'By the kilo', unit: 'g', qty: null, products: things.filter((p) => p.size_unit === 'g').map(item) },
    { key: 'ea:per', label: 'Each', unit: 'ea', qty: null, products: things.filter((p) => p.size_unit === 'ea').map(item) },
  ].filter((g) => g.products.length);
  for (const g of groups) {
    g.products.sort((a, b) => (a.perUnit ?? Infinity) - (b.perUnit ?? Infinity) || a.price - b.price);
    g.count = g.products.length;
    const perStore = {};
    for (const p of g.products) if (!perStore[p.store]) perStore[p.store] = p;
    g.cheapestPerStore = perStore;
    g.products = g.products.slice(0, PER_SIZE);
  }
  return groups;
}

// Things people search for by kind rather than by size: bread (loaves, rolls,
// wraps… and white, wholemeal…) and pickles (mustard pickles, gherkins,
// pickled onions…). Each family says how to read a search and sort a product.
const FAMILIES = [
  {
    aisle: 'bakery',
    query: (q) => {
      const w = breadQuery(q);
      return w && { type: w.type, sub: w.grain, rest: w.rest };
    },
    // Every type's words are searched, since rolls and wraps needn't say "bread".
    words: (want) => (want.type ? [TYPE_SEARCH[want.type], want.type === 'loaf' ? 'bread' : null]
      : ['bread', 'loaf', 'roll', 'bun', 'wrap', 'tortilla', 'pita', 'naan', 'bagel', 'crumpet', 'english muffin', 'baguette', 'turkish', 'vienna', 'sourdough', 'toast']),
    typeOf: (p) => breadType(p.name, p.category),
    subOf: (p) => breadGrain(p.name),
    types: TYPE_ORDER.map((key) => ({ key, label: typeLabel(key), search: TYPE_SEARCH[key] })),
    subs: BREAD_GRAINS.map((g) => ({ key: g.key, label: g.label, search: g.search })),
  },
  {
    aisle: 'pantry',
    query: (q) => {
      const w = pickleQuery(q);
      return w && { type: w.type, sub: null, rest: w.rest };
    },
    words: () => ['pickle', 'pickled', 'gherkin', 'cornichon', 'sauerkraut', 'kimchi', 'piccalilli'],
    typeOf: (p) => pickleType(p.name),
    subOf: null,
    types: PICKLE_TYPES.map((t) => ({ key: t.key, label: t.label, search: t.search })),
    subs: null,
  },
];

/**
 * The cheapest of each type in a family (loaves, rolls…), or of each sub-kind
 * when a type was asked for (white rolls, wholemeal rolls…), by price per kg
 * (or per item for what's sold by the pack), with chips for the kinds there
 * are. A type with nothing more to split it by: one ranking. Null if there's
 * nothing, so the usual answer is given instead.
 */
function kindPrices(asTyped, fam, want, { stores, igaStore, memberships, alcohol }) {
  const extra = want.rest.join(' ');
  const seen = new Map();
  for (const w of fam.words(want).filter(Boolean)) {
    for (const p of runSearch(`${extra} ${w}`.trim(), { stores, igaStore, limit: CANDIDATES, alcohol })) seen.set(p.id, p);
  }
  const rest = want.rest.flatMap((w) => [...nameTokens(w)]);
  const found = [...seen.values()]
    .filter((p) => p.price > 0 && p.size_unit && (p.size_qty || p.per_weight) && sectionOf(p) === fam.aisle)
    .map((p) => ({ p, type: fam.typeOf(p), sub: fam.subOf?.(p) ?? null }))
    .filter((b) => b.type && (!want.type || b.type === want.type) && (!want.sub || b.sub === want.sub))
    // Other words (a brand, "dill") have to be in the name.
    .filter((b) => rest.every((w) => [...nameTokens(b.p.name, null)].some((t) => sameWord(t, w))));
  if (!found.length) return null;

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
  // Cheapest first by price per kg / L, or per item if most of them are sold by the pack.
  const rank = (list) => {
    const units = {};
    for (const b of list) units[b.p.size_unit] = (units[b.p.size_unit] || 0) + 1;
    const unit = Object.entries(units).sort((a, b) => b[1] - a[1])[0][0];
    const unitOf = new Map(list.map((b) => [b.p.id, b.p.size_unit]));
    return list.map((b) => item(b.p)).sort((a, b) => ((unitOf.get(b.id) === unit) - (unitOf.get(a.id) === unit))
      || (a.perUnit ?? Infinity) - (b.perUnit ?? Infinity) || a.price - b.price);
  };
  const group = (key, label, list, search, shown) => {
    const products = rank(list);
    const perStore = {};
    for (const p of products) if (!perStore[p.store]) perStore[p.store] = p;
    return { key, label, unit: products[0].unitWord === 'each' || products[0].unitWord === 'item' ? 'ea' : 'g', qty: null, count: products.length, products: products.slice(0, shown), cheapestPerStore: perStore, search };
  };
  const labelOf = (list, k) => list.find((x) => x.key === k)?.label || k;

  const ranked = !!want.type && (!fam.subs || !!want.sub);
  const by = want.type ? 'sub' : 'type';
  let groups;
  if (ranked) {
    const label = want.sub ? `${labelOf(fam.subs, want.sub)} ${labelOf(fam.types, want.type).toLowerCase()}` : labelOf(fam.types, want.type);
    groups = [group('asked', label, found, null, RANKED)];
  } else {
    const kinds = by === 'type' ? fam.types : fam.subs;
    const parts = new Map();
    for (const b of found) {
      if (!parts.has(b[by])) parts.set(b[by], []);
      parts.get(b[by]).push(b);
    }
    groups = kinds.filter((k) => parts.has(k.key)).map((k) => group(k.key, k.label, parts.get(k.key), k.search, PER_SIZE));
  }

  // Chips: the sub-kinds there are (when none was asked for), then the types (when only a sub-kind was).
  const count = (k, v) => found.filter((b) => b[k] === v).length;
  const chips = (list) => (list.length > 1 ? list : []); // one choice isn't a choice
  const variants = [
    ...(want.sub || !fam.subs ? [] : chips(fam.subs.filter((g) => count('sub', g.key) >= 2).map((g) => ({ word: g.search, label: g.label })))),
    ...(want.type || !want.sub ? [] : chips(fam.types.filter((t) => count('type', t.key) >= 2).map((t) => ({ word: t.search, label: t.label })))),
  ];
  return { query: asTyped, size: null, aisle: fam.aisle, mixed: false, variants, kinds: { by: by === 'type' ? 'type' : 'kind' }, ranked, groups };
}

/**
 * @param {string} q the search as typed
 * @param {{stores?: string[], igaStore?: string, memberships?: string[]}} opts
 */
export function bestPrices(q, opts = {}) {
  const key = JSON.stringify([String(q).trim().toLowerCase(), opts.stores || null, opts.igaStore || null, [...(opts.memberships || [])].sort(), opts.alcohol ?? true, catalogueVersion()]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = compute(q, opts);
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function compute(q, { stores, igaStore, memberships = [], alcohol = true } = {}) {
  const asTyped = String(q).trim();
  q = expandQuery(q);
  const size = parseSizeFrom(q);
  if (!size) {
    for (const fam of FAMILIES) {
      const want = fam.query(asTyped);
      const answer = want && kindPrices(asTyped, fam, want, { stores, igaStore, memberships, alcohol });
      if (answer) return answer;
    }
  }
  const text = size ? String(q).replace(SIZE_TOKEN_RE, ' ') : String(q);
  const wanted = nameTokens(text);
  if (!wanted.size) return null;

  const empty = { query: asTyped, size: size ? formatSize(size.qty, size.unit) : null, groups: [], variants: [] };
  // Every word searched for has to be in the product's own name (not just its
  // shop category: "Dairy, Eggs & Fridge" doesn't make yoghurt eggs).
  const asked = (t) => [...wanted].some((w) => sameWord(t, w));
  const search = (sized) => runSearch(text, { stores, igaStore, limit: CANDIDATES, size: sized, alcohol })
    .filter((p) => p.price != null && p.size_unit && (p.size_qty || p.per_weight))
    .filter((p) => {
      const own = [...nameTokens(p.name, null)];
      return [...wanted].every((w) => own.some((t) => sameWord(t, w)));
    });

  let found = search(size);
  let aisle = found.length ? mainSection(found, wanted) : null;
  // Fruit and veg are sold by the kilo or by the item, whatever size the
  // search said ("bananas 1kg"): compare them that way.
  if (size && size.unit !== 'ml') {
    const loose = search(null);
    if (loose.length && mainSection(loose, wanted) === 'produce') {
      found = loose;
      aisle = 'produce';
    }
  }
  if (!found.length) return empty;
  const produce = aisle === 'produce';
  found = found.filter((p) => sectionOf(p) === aisle);

  // Plain versions only, unless there aren't enough of them.
  const extraVariants = (p) => [...tokensOf(p)].filter((t) => VARIANT_WORDS.has(t) && !GRADES.has(t) && !asked(t));
  const otherChoices = (p) => [...tokensOf(p)].filter((t) => VARIANT_WORDS.has(t) && !asked(t));
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

  if (produce) return { query: asTyped, size: null, aisle, mixed, variants, produce: true, groups: produceGroups(pool, wanted, item) };

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
    const endsWith = (p, n) => namedFor(p, wanted, n);
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
