// ALDI Australia: the website is backed by a public JSON API at api.aldi.com.au.
// Category tree: /v2/product-category-tree; products: /v3/product-search.
// Prices are in cents. Like Woolworths it sits behind Akamai, so run it from a
// residential connection (or SCRAPE_MODE=browser) if it's blocked.

import { createClient } from './http.js';

const ORIGIN = 'https://www.aldi.com.au';
const API = 'https://api.aldi.com.au';
const PAGE_SIZE = 60; // the API rejects anything above 60
const SKIP = new Set(
  (process.env.ALDI_SKIP_CATEGORIES ??
    'christmas,easter,halloween,lower-prices,super-savers,limited-time-only,higher-protein-food-and-drink,front-of-store,the-people-s-picks').split(',').map((s) => s.trim()).filter(Boolean),
);

export const store = 'aldi';

const newClient = async () => {
  const client = createClient({ origin: ORIGIN, delayMs: Number(process.env.ALDI_DELAY_MS ?? 500) });
  await client.init();
  return client;
};
async function categoryTree(client) {
  const tree = await client.getJson(`${API}/v2/product-category-tree`);
  return (tree.data || [])
    .map((c) => ({ key: c.key ?? c.id, name: c.name, slug: c.urlSlugText ?? c.slug }))
    .filter((c) => c.key && !SKIP.has(c.slug));
}

/** The departments to crawl: [{ key, name, slug }] (one request). */
export async function departments() {
  const client = await newClient();
  try {
    return await categoryTree(client);
  } finally {
    await client.close();
  }
}

/** `categories`: departments already fetched with departments() (when the crawl is shared out). */
export async function* scrape({ log = console.log, maxPagesPerCategory = Infinity, onlyCategories, categories } = {}) {
  const client = await newClient();
  try {
    let cats = categories || await categoryTree(client);
    if (onlyCategories?.length) cats = cats.filter((c) => onlyCategories.includes(c.slug));
    log(`aldi: ${cats.length} categories`);

    for (const cat of cats) {
      let offset = 0;
      let total = 0;
      let page = 0;
      do {
        const qs = new URLSearchParams({
          currency: 'AUD',
          serviceType: 'walk-in',
          categoryTree: cat.key,
          limit: String(PAGE_SIZE),
          offset: String(offset),
          sort: 'relevance',
        });
        const json = await client.getJson(`${API}/v3/product-search?${qs}`);
        total = json.meta?.pagination?.totalCount ?? 0;
        const items = (json.data || []).map((p) => mapProduct(p, cat.name));
        page++;
        log(`aldi: ${cat.slug} page ${page}/${Math.ceil(total / PAGE_SIZE)} (${items.length})`);
        yield items;
        if (!items.length) break;
        offset += PAGE_SIZE;
      } while (offset < total && page < maxPagesPerCategory);
    }
  } finally {
    await client.close();
  }
}

export function mapProduct(p, categoryName) {
  const price = p.price || {};
  const cents = price.amount ?? null;
  const slug = p.urlSlugText || '';
  const img = p.assets?.[0]?.url;
  const brand = titleCase(p.brandName);
  return {
    store_product_id: p.sku,
    name: brand && !String(p.name).toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${p.name}` : p.name,
    brand,
    size_text: p.sellingSize || null,
    category: p.categories?.[0]?.name || categoryName,
    image_url: img ? img.replace('{width}', '300').replace('{slug}', slug) : null,
    product_url: `${ORIGIN}/product/${slug}-${p.sku}`,
    price: cents != null ? cents / 100 : null,
    was_price: price.wasPriceDisplay ? parseMoney(price.wasPriceDisplay) : null,
    unit_price_text: price.comparisonDisplay || null,
    on_special: !!price.wasPriceDisplay,
    // notForSale only means "not sold online" — ALDI is in-store only anyway.
    available: cents != null && !p.discontinued,
  };
}

// ALDI sends brands in capitals ("EMPORIUM SELECTION").
function titleCase(s) {
  if (!s) return null;
  return String(s).toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

function parseMoney(s) {
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}
