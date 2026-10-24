// Decides whether two products from (possibly) different stores are "the same
// thing": identical pack size plus a similar name once brand, size and store
// words are stripped. "Coles Full Cream Milk 3L", "Woolworths Full Cream Milk 3L"
// and "Farmdale Full Cream Milk 3L" all reduce to {full, cream, milk} @ 3000ml.

import { SIZE_TOKEN_RE, sameSize } from './units.js';

const STORE_WORDS = new Set([
  'coles', 'woolworths', 'woolies', 'ww', 'aldi', 'macro', 'essentials', 'homebrand',
  'simply', 'finest', 'specially', 'selected', 'everyday', 'value',
]);

const STOPWORDS = new Set([
  'the', 'and', 'with', 'of', 'a', 'an', 'in', 'for', 'to', 'or', 'on', 'from',
  'pack', 'pk', 'each', 'ea', 'bottle', 'bottles', 'can', 'cans', 'jar', 'box', 'bag', 'tub',
  'punnet', 'tray', 'multipack', 'value', 'range', 'new', 'product', 'x', 'dairy', 'australian', 'aussie',
]);

// Light-touch synonyms so wording differences between stores still line up.
const SYNONYMS = {
  whole: 'fullcream', lite: 'light', choc: 'chocolate', chocolates: 'chocolate',
  tomatoes: 'tomato', potatoes: 'potato', bananas: 'banana', apples: 'apple', eggs: 'egg',
  biscuits: 'biscuit', chips: 'chip', crisps: 'chip', noodles: 'noodle', yoghurt: 'yogurt',
  sultanas: 'sultana', carrots: 'carrot', onions: 'onion', oranges: 'orange', lemons: 'lemon',
  tissues: 'tissue', towels: 'towel', capsules: 'capsule', pods: 'pod',
  breasts: 'breast', fillets: 'fillet', thighs: 'thigh', sausages: 'sausage', rashers: 'rasher',
};

// Words that define a *different* product variant. If one name has one of
// these and the other doesn't, they aren't the same item no matter how similar
// the rest of the name is ("Lactose Free Full Cream Milk" ≠ "Full Cream Milk").
export const VARIANT_WORDS = new Set([
  'light', 'low', 'reduced', 'skim', 'lactose', 'free', 'organic', 'protein', 'unsalted', 'salted',
  'sliced', 'slice', 'grated', 'shredded', 'block', 'spreadable', 'vintage', 'extra', 'mild', 'sharp',
  'wholemeal', 'white', 'multigrain', 'wholegrain', 'sourdough', 'sugar', 'diet', 'zero', 'decaf', 'gluten',
  'vegan', 'plant', 'oat', 'almond', 'soy', 'coconut', 'rice', 'barista', 'uht', 'chocolate', 'strawberry',
  'vanilla', 'banana', 'caramel', 'honey', 'garlic', 'chilli', 'spicy', 'hot', 'smoked', 'salt', 'vinegar',
  'chicken', 'beef', 'pork', 'lamb', 'fish', 'tuna', 'cheese', 'onion', 'tomato', 'sour', 'cream', 'thickened',
  'double', 'crunchy', 'smooth', 'frozen', 'kids', 'baby', 'toddler', 'mini', 'thin', 'thick', 'boneless', 'skinless', 'mince', 'diced', 'half', 'brown', 'red', 'green',
  'black', 'longlife', 'unscented', 'sensitive', 'concentrate', 'concentrated', 'refill', 'cage', 'freerange', 'barn',
  '1%', '2%', 'a2', 'flavoured', 'iced', 'coffee', 'powder', 'whitener', 'creamer', 'sauce', 'spread', 'crumbs', 'flour',
]);

export const MATCH_THRESHOLD = 0.75;

/** Tokens describing *what* the product is, independent of store and brand. */
export function nameTokens(name, brand) {
  let s = ` ${String(name || '').toLowerCase()} `;
  s = s.replace(SIZE_TOKEN_RE, ' ');
  s = s.replace(/free[\s-]range/g, 'freerange').replace(/full[\s-]cream/g, 'fullcream')
    .replace(/long[\s-]life/g, 'longlife');
  const out = new Set();
  if (brand) {
    const b = String(brand).toLowerCase().trim();
    if (b) {
      s = s.replace(b, ' ');
      // Sub-brands like "Coles Organic" still describe the product variant.
      for (const t of b.split(/[^a-z0-9%]+/)) if (VARIANT_WORDS.has(t)) out.add(t);
    }
  }
  for (let t of s.split(/[^a-z0-9%]+/)) {
    if (!t || t.length < 2 && !/\d/.test(t)) continue;
    if (STORE_WORDS.has(t) || STOPWORDS.has(t)) continue;
    if (/^\d+(\.\d+)?$/.test(t)) continue; // bare numbers are usually counts already in size
    t = SYNONYMS[t] || t;
    if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
    out.add(t);
  }
  return out;
}

// Each product's tokens, worked out once. Kept off the product object itself so
// they never end up in API responses.
const tokenCache = new WeakMap();
export function tokensOf(p) {
  let t = tokenCache.get(p);
  if (!t) {
    t = nameTokens(p.name, p.brand);
    tokenCache.set(p, t);
  }
  return t;
}

/** Dice coefficient between two token sets (0..1). */
export function tokenSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return (2 * inter) / (a.size + b.size);
}

function sizesOf(p) {
  const out = [];
  if (p.size_unit) out.push({ qty: p.size_qty, unit: p.size_unit });
  if (p.alt_size_unit) out.push({ qty: p.alt_size_qty, unit: p.alt_size_unit });
  return out;
}

/** Same pack if any way of measuring the two packs agrees. */
export function samePack(a, b) {
  const sa = sizesOf(a);
  const sb = sizesOf(b);
  // When both have a weight (or both a volume), that decides: a dozen 600g eggs
  // aren't a dozen 700g eggs. A count only matches when one side has no weight.
  for (const unit of ['g', 'ml']) {
    const x = sa.filter((s) => s.unit === unit);
    const y = sb.filter((s) => s.unit === unit);
    if (x.length && y.length) return x.some((p) => y.some((q) => sameSize(p, q)));
  }
  return sa.some((x) => sb.some((y) => sameSize(x, y)));
}

export function sameBrand(a, b) {
  const x = (a.brand || '').toLowerCase().trim();
  const y = (b.brand || '').toLowerCase().trim();
  return !!x && x === y;
}

/**
 * Score how well `candidate` matches `anchor`. Returns 0 when they can't be
 * the same product (different sizes, or brand mismatch in 'exact' mode).
 * @param {'similar'|'exact'} mode
 */
/** @param {{ignoreSize?: boolean}} opts  ignoreSize: same item in any pack size (for "better value" hints) */
export function matchScore(anchor, candidate, mode = 'similar', { ignoreSize = false } = {}) {
  if (anchor.id != null && anchor.id === candidate.id) return 1;
  if (!ignoreSize && !samePack(anchor, candidate)) return 0;
  if (mode === 'exact' && !sameBrand(anchor, candidate)) return 0;
  const a = tokensOf(anchor);
  const c = tokensOf(candidate);
  for (const t of a) if (VARIANT_WORDS.has(t) && !c.has(t)) return 0;
  for (const t of c) if (VARIANT_WORDS.has(t) && !a.has(t)) return 0;
  let score = tokenSimilarity(a, c);
  // Same brand only breaks ties between genuine matches; it never creates one.
  if (score >= MATCH_THRESHOLD && sameBrand(anchor, candidate)) score = Math.min(1, score + 0.1);
  return Math.round(score * 1000) / 1000;
}

/**
 * Rank candidates for an anchor product.
 * @returns {Array<{product:object, score:number}>} best first, above threshold
 */
export function rankMatches(anchor, candidates, mode = 'similar', threshold = MATCH_THRESHOLD) {
  const out = [];
  for (const c of candidates) {
    const score = matchScore(anchor, c, mode);
    if (score >= threshold) out.push({ product: c, score });
  }
  out.sort((x, y) => y.score - x.score || (x.product.price ?? Infinity) - (y.product.price ?? Infinity));
  return out;
}
