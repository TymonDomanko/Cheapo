// Harris Farm Markets runs on Shopify, which publishes the whole catalogue at
// /products.json (250 products a page).

import { createClient } from './http.js';

const ORIGIN = 'https://www.harrisfarm.com.au';
const PAGE_SIZE = 250;
// Gift hampers, flowers etc. aren't groceries.
const SKIP_TYPES = /hamper|gift|flower|voucher|merch|non food/i;

export const store = 'harrisfarm';

export async function* scrape({ log = console.log, maxPagesPerCategory = Infinity } = {}) {
  const client = createClient({ origin: ORIGIN, delayMs: Number(process.env.HARRISFARM_DELAY_MS ?? 800) });
  await client.init();
  try {
    for (let page = 1; page <= maxPagesPerCategory; page++) {
      const json = await client.getJson(`${ORIGIN}/products.json?limit=${PAGE_SIZE}&page=${page}`);
      const products = json.products || [];
      if (!products.length) break;
      const items = products.filter((p) => !SKIP_TYPES.test(p.product_type || '')).flatMap(mapProduct);
      log(`harrisfarm: page ${page} (${items.length})`);
      yield items;
    }
  } finally {
    await client.close();
  }
}

/** One Shopify product can have several variants (sizes); each becomes a product. */
export function mapProduct(p) {
  const variants = p.variants || [];
  return variants.map((v) => {
    const multi = variants.length > 1 && v.title && v.title !== 'Default Title';
    const price = v.price != null ? Number(v.price) : null;
    const was = v.compare_at_price != null ? Number(v.compare_at_price) : null;
    return {
      store_product_id: multi ? `${p.id}-${v.id}` : String(p.id),
      name: multi ? `${p.title} ${v.title}` : p.title,
      brand: p.vendor && !/^hfm$/i.test(p.vendor) ? p.vendor : null,
      // The size is part of the title ("Nutcracker 200g", "Bananas per kg").
      size_text: multi ? v.title : null,
      // product_type looks like "Grocery-Biscuits", "S08S-Fruit" or "D_Fruit".
      category: String(p.product_type || '').split(/[-_]/).pop().trim() || null,
      image_url: p.images?.[0]?.src || null,
      product_url: `${ORIGIN}/products/${p.handle}${multi ? `?variant=${v.id}` : ''}`,
      price,
      was_price: was && price != null && was > price ? was : null,
      on_special: !!(was && price != null && was > price),
      available: v.available !== false && price != null,
    };
  });
}
