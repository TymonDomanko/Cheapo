// IGA: igashop.com.au is backed by a storefront API. IGA stores are
// independently owned and set their own prices, so this reads one store's
// catalogue at a time (opts.location = IGA's retailerStoreId).

import { createClient } from './http.js';
import { parseMultiBuy } from '../promos.js';

const ORIGIN = 'https://www.igashop.com.au';
const PAGE_SIZE = 100;
const SKIP = new Set(
  (process.env.IGA_SKIP_CATEGORIES ?? 'Other').split(',').map((s) => s.trim()).filter(Boolean),
);

export const store = 'iga';

export async function* scrape({ log = console.log, maxPagesPerCategory = Infinity, onlyCategories, location } = {}) {
  const storeId = location || process.env.IGA_STORE_ID || '32600';
  const api = `${ORIGIN}/api/storefront/stores/${storeId}`;
  const client = createClient({ origin: ORIGIN, delayMs: Number(process.env.IGA_DELAY_MS ?? 500) });
  await client.init();
  try {
    const tree = await client.getJson(`${api}/categoryHierarchy`);
    // Top level is "Grocery" etc.; its children are the departments we crawl.
    let cats = (tree.children || []).flatMap((c) => c.children || [])
      .map((c) => ({ id: c.identifier, name: c.displayName }))
      .filter((c) => c.id && !SKIP.has(c.id));
    if (onlyCategories?.length) cats = cats.filter((c) => onlyCategories.includes(c.id));
    log(`iga: store ${storeId}, ${cats.length} categories`);

    for (const cat of cats) {
      let skip = 0;
      let total = 0;
      let page = 0;
      do {
        const json = await client.getJson(`${api}/categories/${encodeURIComponent(cat.id)}/search?take=${PAGE_SIZE}&skip=${skip}&sort=relevance`);
        total = json.total ?? 0;
        const items = (json.items || []).map((p) => mapProduct(p, cat.name));
        page++;
        log(`iga: ${cat.id} page ${page}/${Math.ceil(total / PAGE_SIZE)} (${items.length})`);
        yield items;
        if (!items.length) break;
        skip += PAGE_SIZE;
      } while (skip < total && page < maxPagesPerCategory);
    }
  } finally {
    await client.close();
  }
}

const UNIT_ABBR = { g: 'g', kg: 'kg', ml: 'mL', l: 'L', ea: 'each' };

export function mapProduct(p, categoryName) {
  // Names don't include the pack size; it comes separately as unitOfSize.
  const u = p.unitOfSize || {};
  const abbr = UNIT_ABBR[String(u.abbreviation || '').toLowerCase()] || u.abbreviation;
  // Counted items ("14 pads", "a dozen eggs") come with type "each" and no abbreviation.
  const counted = String(u.type || '').toLowerCase() === 'each';
  const size = !u.size ? null : abbr ? `${u.size}${abbr}` : counted ? (u.size > 1 ? `${u.size} pack` : 'each') : null;
  const perKg = String(p.sellBy || '').toLowerCase() === 'weight';
  const slug = String(p.name || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    store_product_id: p.productId || p.sku,
    name: p.name,
    brand: p.brand || null,
    size_text: perKg ? 'per kg' : size,
    category: p.defaultCategory?.[0]?.category || categoryName,
    image_url: p.image?.default || p.image?.cell || null,
    product_url: `${ORIGIN}/product/${slug}-${p.productId || p.sku}`,
    price: p.priceNumeric ?? null,
    was_price: p.wasPriceNumeric && p.wasPriceNumeric > (p.priceNumeric ?? 0) ? p.wasPriceNumeric : null,
    unit_price_text: p.pricePerUnit || null,
    on_special: p.priceSource && p.priceSource !== 'regular',
    available: p.available !== false && p.priceNumeric != null,
    // IGA shows deals like "2 for $5" in priceLabel.
    multi_qty: parseMultiBuy(p.priceLabel)?.qty ?? null,
    multi_price: parseMultiBuy(p.priceLabel)?.total ?? null,
    promo_text: p.priceLabel || null,
  };
}
