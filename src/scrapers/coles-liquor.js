// Liquorland (Coles' liquor shops; First Choice and Vintage Cellars now
// redirect to it) has a JSON product API:
//   /api/products/<site>/<state>/<category>?page=N   36 products a page
// Prices are per state (LIQUOR_STATE, default nsw). Each listing is already one
// way of buying a product (a bottle, a 30-block, a case of 24), so each is a
// product, sized "24 x 330mL". "Across any six" is the per-bottle price when
// buying six: a multi-buy.

import { createClient } from './http.js';
import { liquorCategory } from './endeavour.js';

const CATEGORIES = [
  { key: 'beer', name: 'Beer & Cider' },
  { key: 'wine', name: 'Wine' },
  { key: 'spirits', name: 'Spirits' },
  { key: 'premix', name: 'Premix Drinks' },
  // ("Beer & Cider" and the rest name the department; a product's own category, like "Sparkling", is kept when it says what it is.)
];

/** @param {{store: string, site: string, origin: string}} cfg */
export function colesLiquor(cfg) {
  const state = () => String(process.env.LIQUOR_STATE || 'nsw').toLowerCase();
  const delayMs = () => Number(process.env[`${cfg.store.toUpperCase()}_DELAY_MS`] ?? 800);

  /** The departments to crawl (fixed: the four the shops list). */
  async function departments() {
    return CATEGORIES.map((c) => ({ ...c, slug: c.key }));
  }

  /** state: whose prices (otherwise LIQUOR_STATE, or NSW). */
  async function* scrape({ log = console.log, maxPagesPerCategory = Infinity, onlyCategories, categories, state: forState = null } = {}) {
    let cats = categories || await departments();
    if (onlyCategories?.length) cats = cats.filter((c) => onlyCategories.includes(c.key));
    const client = createClient({ origin: cfg.origin, delayMs: delayMs() });
    await client.init();
    try {
      for (const cat of cats) {
        let n = 1;
        let pages = 1;
        do {
          const json = await client.getJson(`${cfg.origin}/api/products/${cfg.site}/${String(forState || state()).toLowerCase()}/${cat.key}?page=${n}`);
          pages = json.meta?.page?.total || 0;
          const items = (json.products || []).map((p) => mapProduct(p, cat.name)).filter(Boolean);
          log(`${cfg.store}: ${cat.key} page ${n}/${pages} (${items.length})`);
          yield items;
          if (!json.products?.length) break;
          n++;
        } while (n <= pages && n <= maxPagesPerCategory);
      }
    } finally {
      await client.close();
    }
  }

  function mapProduct(p, category) {
    if (!p?.id || !p.name) return null;
    const count = /^ea$/i.test(p.unitOfMeasure || 'ea') ? 1 : Number(String(p.unitOfMeasure).match(/(\d+)/)?.[1]) || 1;
    const vol = p.volumeMl > 0 ? (p.volumeMl >= 1000 && p.volumeMl % 100 === 0 ? `${p.volumeMl / 1000}L` : `${p.volumeMl}mL`) : null;
    const price = p.price?.current > 0 ? p.price.current : null;
    const was = p.price?.normal > (price || 0) ? p.price.normal : null;
    const anySix = count === 1 && p.price?.acrossAnySix > 0 && p.price.acrossAnySix < (price || 0) ? p.price.acrossAnySix : 0;
    const pack = count > 1 && !new RegExp(`\\b${count}\\s*(pk|pack)\\b`, 'i').test(p.name);
    const image = p.image?.heroImage || p.image?.thumbnailImage;
    return {
      store_product_id: String(p.id),
      name: pack ? `${p.name} ${/^ctn/i.test(p.unitOfMeasure) ? 'Case' : 'Pack'}` : p.name,
      brand: p.brand || null,
      size_text: vol ? (count > 1 ? `${count} x ${vol}` : vol) : count > 1 ? `${count} pack` : null,
      category: liquorCategory(p.category, category),
      image_url: image ? new URL(image, cfg.origin).href : null,
      product_url: p.productUrl ? new URL(p.productUrl, cfg.origin).href : null,
      price,
      was_price: was,
      on_special: !!was,
      promo_text: p.promotion?.calloutText || null,
      multi_qty: anySix ? 6 : null,
      multi_price: anySix ? Math.round(anySix * 6 * 100) / 100 : null,
      member_price: p.price?.memberOnlyPrice > 0 ? p.price.memberOnlyPrice : null,
      available: p.isAvailable !== false,
    };
  }

  return { store: cfg.store, departments, scrape, mapProduct };
}
