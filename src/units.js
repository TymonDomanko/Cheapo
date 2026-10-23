// Parses pack sizes ("3L", "6 x 375mL", "Per Kg", "12 Pack") into a single
// normalised quantity so products from different stores can be compared.
// Every size resolves to grams (g), millilitres (ml) or a count (ea).

const UNIT_MAP = {
  g: ['g', 1], gm: ['g', 1], gms: ['g', 1], gram: ['g', 1], grams: ['g', 1],
  kg: ['g', 1000], kgs: ['g', 1000], kilo: ['g', 1000], kilogram: ['g', 1000], kilograms: ['g', 1000],
  mg: ['g', 0.001],
  ml: ['ml', 1], mls: ['ml', 1], millilitre: ['ml', 1], millilitres: ['ml', 1], milliliter: ['ml', 1],
  cl: ['ml', 10],
  l: ['ml', 1000], lt: ['ml', 1000], ltr: ['ml', 1000], litre: ['ml', 1000], litres: ['ml', 1000],
  liter: ['ml', 1000], liters: ['ml', 1000],
  pk: ['ea', 1], pack: ['ea', 1], packs: ['ea', 1], ea: ['ea', 1], each: ['ea', 1],
  pc: ['ea', 1], pcs: ['ea', 1], piece: ['ea', 1], pieces: ['ea', 1],
  sheets: ['ea', 1], sheet: ['ea', 1], rolls: ['ea', 1], roll: ['ea', 1],
  capsules: ['ea', 1], caps: ['ea', 1], tablets: ['ea', 1], tabs: ['ea', 1],
  bags: ['ea', 1], bag: ['ea', 1], bunch: ['ea', 1], bunches: ['ea', 1], pods: ['ea', 1], wipes: ['ea', 1], count: ['ea', 1],
};

const UNIT_ALT = Object.keys(UNIT_MAP).sort((a, b) => b.length - a.length).join('|');
const NUM = '(\\d+(?:\\.\\d+)?)';
const MULTI_RE = new RegExp(`${NUM}\\s*(?:x|×|\\*)\\s*${NUM}\\s*(${UNIT_ALT})\\b`, 'i');
const MULTI_REV_RE = new RegExp(`${NUM}\\s*(${UNIT_ALT})\\s*(?:x|×|\\*)\\s*${NUM}\\b`, 'i');
const SINGLE_RE = new RegExp(`${NUM}\\s*(${UNIT_ALT})\\b`, 'i');
const PER_RE = new RegExp(`\\bper\\s*(?:1\\s*)?(${UNIT_ALT})\\b`, 'i');

function unitOf(token) {
  return UNIT_MAP[token.toLowerCase()] || null;
}

/**
 * @param {string} text  e.g. "6 x 375mL", "1kg", "Per Kg", "each"
 * @returns {{qty:number, unit:'g'|'ml'|'ea', perWeight:boolean} | null}
 */
export function parseSize(text) {
  if (!text) return null;
  const s = String(text).replace(/,/g, '').trim();

  let m = s.match(MULTI_RE);
  if (m) {
    const u = unitOf(m[3]);
    if (u) return { qty: round(Number(m[1]) * Number(m[2]) * u[1]), unit: u[0], perWeight: false };
  }
  m = s.match(MULTI_REV_RE);
  if (m) {
    const u = unitOf(m[2]);
    if (u) return { qty: round(Number(m[1]) * Number(m[3]) * u[1]), unit: u[0], perWeight: false };
  }
  m = s.match(PER_RE);
  if (m) {
    const u = unitOf(m[1]);
    if (u) return { qty: round(u[1]), unit: u[0], perWeight: u[0] !== 'ea' };
  }
  m = s.match(SINGLE_RE);
  if (m) {
    const u = unitOf(m[2]);
    if (u) return { qty: round(Number(m[1]) * u[1]), unit: u[0], perWeight: false };
  }
  if (/^\s*(each|ea|1\s*each)\s*$/i.test(s)) return { qty: 1, unit: 'ea', perWeight: false };
  return null;
}

/** Try the explicit size field first, then fall back to the product name. */
export function parseSizeFrom(sizeText, name) {
  return parseSize(sizeText) || parseSize(name);
}

/**
 * A second way of measuring the same pack, if the name/size text mentions one
 * in a different unit — e.g. eggs listed as "12 Pack" at one store and "700g"
 * at another. Lets those still be matched.
 */
export function altSize(sizeText, name, primary) {
  if (!primary) return null;
  const text = `${sizeText || ''} ${name || ''}`;
  for (const m of text.matchAll(SIZE_TOKEN_RE)) {
    // A multipack ("10 x 375mL") is also that many items.
    if (m[1] && primary.unit !== 'ea' && parseFloat(m[1]) >= 2) return { qty: parseFloat(m[1]), unit: 'ea', perWeight: false };
    const s = parseSize(m[0]);
    if (s && s.unit !== primary.unit && !s.perWeight) return s;
  }
  return null;
}

/** Regex that strips size mentions out of a product name. */
export const SIZE_TOKEN_RE = new RegExp(
  `(${NUM}\\s*(?:x|×)\\s*)?${NUM}\\s*(${UNIT_ALT})\\b|\\bper\\s*(${UNIT_ALT})\\b`,
  'gi',
);

export function formatSize(qty, unit) {
  if (qty == null || !unit) return '';
  if (unit === 'g') return qty >= 1000 ? `${trim(qty / 1000)}kg` : `${trim(qty)}g`;
  if (unit === 'ml') return qty >= 1000 ? `${trim(qty / 1000)}L` : `${trim(qty)}mL`;
  return `${trim(qty)} pack`;
}

/** Price per 100g / 100mL / each, used for display when a store doesn't give one. */
export function unitPrice(price, qty, unit) {
  if (price == null || !qty) return null;
  if (unit === 'g' || unit === 'ml') return round((price / qty) * 100, 4);
  return round(price / qty, 4);
}

export function unitPriceLabel(unit) {
  if (unit === 'g') return 'per 100g';
  if (unit === 'ml') return 'per 100mL';
  return 'each';
}

/** Two sizes are "the same" if within 1% of each other (absorbs 1L vs 1000mL rounding). */
export function sameSize(a, b) {
  if (!a || !b || a.unit !== b.unit) return false;
  return Math.abs(a.qty - b.qty) <= Math.max(a.qty, b.qty) * 0.01;
}

function round(n, dp = 3) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
function trim(n) {
  return String(round(n, 2));
}
