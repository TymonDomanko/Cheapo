// Coles: the website is a Next.js app, so every category page has a JSON twin
// at /_next/data/<buildId>/en/browse/<slug>.json?page=N (48 products a page).

import { createClient, eachCategory } from './http.js';
import { parseMultiBuy } from '../promos.js';

const ORIGIN = 'https://www.coles.com.au';
const IMAGE_BASE = 'https://cdn.productimages.coles.com.au/productimages';
// Top-level categories that are duplicates of others or not groceries.
const SKIP = new Set(
  (process.env.COLES_SKIP_CATEGORIES ?? 'bonus-credit-products,back-to-school,big-pack-value,deliver-more-range,tobacco')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

export const store = 'coles';

export async function* scrape({ log = console.log, maxPagesPerCategory = Infinity, onlyCategories } = {}) {
  const client = createClient({ origin: ORIGIN, delayMs: Number(process.env.COLES_DELAY_MS ?? 1000) });
  await client.init();
  try {
    const html = await client.getText(ORIGIN + '/');
    const buildId = html.match(/"buildId":"([^"]+)"/)?.[1];
    if (!buildId) throw new Error('Coles: could not find Next.js buildId on home page');
    const data = (p) => `${ORIGIN}/_next/data/${buildId}/en/${p}`;

    const browse = await client.getJson(data('browse.json'));
    let cats = (browse.pageProps?.allProductCategories?.catalogGroupView || [])
      .filter((c) => c.level === 1 && c.type === 'CATALOG' && c.productCount > 0 && !SKIP.has(c.seoToken));
    if (onlyCategories?.length) cats = cats.filter((c) => onlyCategories.includes(c.seoToken));
    log(`coles: ${cats.length} categories, ~${cats.reduce((n, c) => n + c.productCount, 0)} products`);

    yield* eachCategory('coles', cats, log, async function* (cat) {
      let page = 1;
      let pages = 1;
      do {
        const json = await client.getJson(data(`browse/${cat.seoToken}.json?slug=${cat.seoToken}&page=${page}`));
        const r = json.pageProps?.searchResults;
        if (!r) break;
        pages = Math.ceil((r.noOfResults || 0) / (r.pageSize || 48));
        const items = (r.results || []).filter((x) => x._type === 'PRODUCT').map((x) => mapProduct(x, cat.name));
        log(`coles: ${cat.seoToken} page ${page}/${pages} (${items.length})`);
        yield items;
        page++;
      } while (page <= pages && page <= maxPagesPerCategory);
    });
  } finally {
    await client.close();
  }
}

export function mapProduct(x, categoryName) {
  const pr = x.pricing || {};
  const fullName = [x.brand, x.name].filter(Boolean).join(' ');
  const slug = `${fullName} ${x.size || ''}`.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    store_product_id: x.id,
    name: fullName,
    brand: x.brand,
    size_text: x.size,
    category: x.onlineHeirs?.[0]?.category || categoryName,
    image_url: x.imageUris?.[0]?.uri ? IMAGE_BASE + x.imageUris[0].uri : null,
    product_url: `${ORIGIN}/product/${slug}-${x.id}`,
    price: pr.now ?? null,
    was_price: pr.was || null,
    unit_price_text: pr.comparable || null,
    on_special: !!(pr.was && pr.was > pr.now) || !!pr.onlineSpecial || pr.promotionType === 'SPECIAL',
    available: x.availability !== false && pr.now != null,
    ...promotions(pr),
  };
}

/** Coles multi-buys ("Pick any 5 for $10"). Barcodes aren't in listings; see src/barcodes.js. */
function promotions(pr) {
  const deal = pr.multiBuyPromotion ? parseMultiBuy(pr.offerDescription) : null;
  return {
    multi_qty: deal?.qty ?? null,
    multi_price: deal?.total ?? null,
    member_price: null,
    promo_text: pr.offerDescription || null,
  };
}
