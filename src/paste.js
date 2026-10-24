// "Paste a list": turns typed or copied text ("milk, bread, 2 x chips") into
// list items. Each line is matched to products for the shopper to confirm;
// anything that doesn't match well can be added as a free-text note instead.

import { compareSearch } from './compare.js';
import { bestPrices } from './bestprice.js';

const MAX_LINES = 60;

// "500g", "2L", "1.5kg", "6 pack" — sizes, not quantities.
const SIZE_AFTER_NUMBER = /^\s*(?:g|kg|ml|l|lt|litres?|pk|pack|packs|x\s*\d)\b/i;

/** Split pasted text into lines with a quantity and the words to search for. */
export function parseLines(text) {
  return String(text || '')
    .split(/[\n;,•]+/)
    .map((raw) => raw.replace(/^\s*(?:[-*–]|\[\s?[xX ]?\]|\d+[.)](?=\s))\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_LINES)
    .map((line) => {
      let quantity = 1;
      let query = line;
      let m;
      if ((m = query.match(/^(\d{1,2})\s*(?:x|×)\s*(.+)$/i))) {
        // "2 x chips", "2x chips"
        [quantity, query] = [Number(m[1]), m[2]];
      } else if ((m = query.match(/^(.+?)\s*(?:x|×)\s*(\d{1,2})$/i)) || (m = query.match(/^(.+?)\s*\((\d{1,2})\)$/))) {
        // "chips x2", "chips (2)"
        [query, quantity] = [m[1], Number(m[2])];
      } else if ((m = query.match(/^(\d{1,2})\s+(.+)$/)) && !SIZE_AFTER_NUMBER.test(m[2])) {
        // "2 avocados" (but not "2 L milk")
        [quantity, query] = [Number(m[1]), m[2]];
      }
      return { line, quantity: Math.min(99, Math.max(1, quantity || 1)), query: query.trim() };
    })
    .filter((l) => l.query);
}

const words = (s) => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];

/**
 * Suggested products for each pasted line (best first). `confident` means
 * every meaningful word typed appears in the top suggestion's name.
 */
export function previewPaste(text, opts = {}) {
  return parseLines(text).map((l) => {
    let groups = [];
    try {
      groups = compareSearch(l.query, { ...opts, limit: 8 }).slice(0, 4);
    } catch {
      groups = []; // a query FTS can't parse: keep it as a note
    }
    // First the cheapest of it, any brand: for the size typed, or the cheapest of each common size.
    let cheapest = [];
    try {
      const best = bestPrices(l.query, opts);
      cheapest = (best?.groups || []).map((g) => g.products[0]).filter(Boolean).map((p) => ({
        productId: p.id, name: p.name, size: p.size_text || null, store: p.store, price: p.price, cheapest: true,
      }));
    } catch {
      cheapest = [];
    }
    const options = [...cheapest, ...groups.map((g) => ({
      productId: g.anchor.id,
      name: g.anchor.name,
      size: g.anchor.size_text,
      store: g.cheapest,
      price: g.cheapest ? g.best[g.cheapest]?.product.price ?? null : null,
    }))].filter((o, i, all) => all.findIndex((x) => x.productId === o.productId) === i).slice(0, 8);
    const wanted = words(l.query).filter((w) => w.length > 2 || /\d/.test(w));
    const top = options[0] ? new Set(words(options[0].name)) : null;
    const confident = cheapest.length > 0
      || (!!top && wanted.length > 0 && wanted.every((w) => top.has(w) || [...top].some((t) => t.startsWith(w))));
    return { ...l, options, confident };
  });
}
