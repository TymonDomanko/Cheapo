// Woolworths: the website calls JSON endpoints under /apis/ui/. Category pages
// POST to /apis/ui/browse/category; the category tree comes from
// /apis/ui/PiesCategoriesWithSpecials. Woolworths uses Akamai bot protection,
// so this generally only works from a residential connection (or with
// SCRAPE_MODE=browser).

import { createClient, crawlInParallel } from './http.js';

const ORIGIN = 'https://www.woolworths.com.au';
const PAGE_SIZE = 36;
const SKIP = new Set(
  (process.env.WOOLWORTHS_SKIP_CATEGORIES ??
    // Seasonal/duplicate groupings, plus third-party marketplace departments. Marketplace listings
    // inside the other departments are left out by the request (isHideEverydayMarketProducts).
    'specials,everyday-market,healthylife,halloween,christmas,easter,container-bonus-credits,back-to-school,dinner,lunch-box,gift-ideas,electronics,home-lifestyle,front-of-store')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

export const store = 'woolworths';

const delayMs = () => Number(process.env.WOOLWORTHS_DELAY_MS ?? 600);

/** The departments to crawl: [{ id, name, slug }] (one request). */
export async function departments() {
  const client = createClient({ origin: ORIGIN, delayMs: delayMs() });
  await client.init();
  try {
    const tree = await client.getJson(`${ORIGIN}/apis/ui/PiesCategoriesWithSpecials`);
    return (tree.Categories || tree.categories || [])
      .map((c) => ({
        id: c.NodeId ?? c.nodeId,
        name: c.Description ?? c.description,
        slug: c.UrlFriendlyName ?? c.urlFriendlyName,
      }))
      .filter((c) => c.id && c.slug && !SKIP.has(c.slug) && !/special/i.test(c.slug));
  } finally {
    await client.close();
  }
}

/**
 * The Woolworths store whose prices this connection gets. Without a login the
 * store can't be chosen: Woolworths picks one from where the connection is.
 */
export async function area() {
  const client = createClient({ origin: ORIGIN, delayMs: 0 });
  await client.init();
  try {
    const boot = await client.getJson(`${ORIGIN}/api/ui/v2/bootstrap`);
    const id = boot?.GetDeliveryInfoRequest?.FulfilmentStoreId ?? boot?.ShopperRequest?.FulfilmentStoreId;
    return id ? String(id) : null;
  } finally {
    await client.close();
  }
}

/** `categories`: departments already fetched with departments() (when the crawl is shared out). */
export async function* scrape({ log = console.log, maxPagesPerCategory = Infinity, onlyCategories, categories } = {}) {
  let cats = categories || await departments();
  if (onlyCategories?.length) cats = cats.filter((c) => onlyCategories.includes(c.slug));
  // Two departments at a time, each in its own session. A session that has made
  // hundreds of requests gets slowed right down, so each department starts a fresh one.
  const workers = Math.max(1, Number(process.env.WOOLWORTHS_CONCURRENCY) || 2);
  log(`woolworths: ${cats.length} categories, ${workers} at a time`);

  yield* crawlInParallel('woolworths', cats, {
    workers,
    log,
    newClient: async () => {
      const c = createClient({ origin: ORIGIN, delayMs: delayMs() });
      await c.init();
      return c;
    },
    crawl: async function* (c, cat) {
      if (c.cookies) {
        // A fresh session (browser mode keeps its one browser).
        c.cookies.clear();
        await c.init();
      }
      let page = 1;
      let pages = 1;
      do {
        const json = await c.postJson(`${ORIGIN}/apis/ui/browse/category`, {
          categoryId: cat.id,
          pageNumber: page,
          pageSize: PAGE_SIZE,
          sortType: 'TraderRelevance',
          url: `/shop/browse/${cat.slug}`,
          location: `/shop/browse/${cat.slug}`,
          formatObject: JSON.stringify({ name: cat.name }),
          isSpecial: false,
          isBundle: false,
          isMobile: false,
          filters: [],
          token: '',
          gpBoost: 0,
          isHideUnavailableProducts: false,
          isRegisteredRewardCardPromotion: false,
          enableAdReRanking: false,
          groupEdmVariants: true,
          categoryVersion: 'v2',
          // Leave out Everyday Market (third-party sellers): ~90% of listings, none of them groceries.
          isHideEverydayMarketProducts: true,
        });
        const total = json.TotalRecordCount ?? json.totalRecordCount ?? 0;
        pages = Math.ceil(total / PAGE_SIZE);
        const items = ownRange(extractProducts(json)).map((p) => mapProduct(p, cat.name));
        log(`woolworths: ${cat.slug} page ${page}/${pages} (${items.length})`);
        yield items;
        if (!items.length) break;
        page++;
      } while (page <= pages && page <= maxPagesPerCategory);
    },
  });
}

/** Woolworths' own range: no Everyday Market (third-party marketplace) listings. */
export function ownRange(products) {
  return products.filter((p) => !p.IsMarketProduct);
}

/** Products arrive grouped in "bundles" (variants); flatten them. */
export function extractProducts(json) {
  const bundles = json.Bundles || json.bundles || json.Products || [];
  const out = [];
  for (const b of bundles) {
    const inner = b.Products || b.products;
    if (Array.isArray(inner)) out.push(...inner);
    else if (b.Stockcode) out.push(b);
  }
  return out;
}

export function mapProduct(p, categoryName) {
  const stockcode = p.Stockcode ?? p.stockcode;
  return {
    store_product_id: stockcode,
    name: p.DisplayName || p.Name,
    brand: p.Brand || null,
    size_text: p.PackageSize || null,
    category: safeFirst(p.AdditionalAttributes?.piessubcategorynamesjson) || categoryName,
    image_url: p.MediumImageFile || p.SmallImageFile || null,
    product_url: `${ORIGIN}/shop/productdetails/${stockcode}/${p.UrlFriendlyName || ''}`,
    price: p.Price ?? p.InstorePrice ?? null,
    was_price: p.WasPrice && p.WasPrice > (p.Price ?? 0) ? p.WasPrice : null,
    unit_price_text: p.CupString || null,
    on_special: !!p.IsOnSpecial || !!p.IsHalfPrice,
    barcode: /^\d{8,14}$/.test(String(p.Barcode || '')) ? String(p.Barcode) : null,
    ...promotions(p),
    available: p.IsAvailable !== false && p.IsPurchasable !== false && p.Price != null,
  };
}

function safeFirst(jsonText) {
  if (!jsonText) return null;
  try {
    const v = JSON.parse(jsonText);
    return Array.isArray(v) ? v[0] : null;
  } catch {
    return null;
  }
}

/** Multi-buy ("5 for $9.00") and Everyday Rewards member prices. */
function promotions(p) {
  const tag = p.CentreTag || {};
  const multi = tag.MultibuyData;
  const memberData = tag.MemberPriceData || tag.FFPVMemberPriceData;
  const member = Number(memberData?.MemberPrice ?? memberData?.Price ?? (p.IsEdrSpecial ? p.EdrSpecialPrice : NaN));
  const text = String(tag.TagContentText || '').trim();
  return {
    multi_qty: multi?.Quantity >= 2 ? multi.Quantity : null,
    multi_price: multi?.Quantity >= 2 && multi.Price > 0 ? multi.Price : null,
    member_price: Number.isFinite(member) && member > 0 ? member : null,
    // Only deals worth showing; "Was $3.30 - 25/08/2026" is already covered by was_price.
    promo_text: multi || Number.isFinite(member) ? text.replace(/\s*-\s*\$[\d.]+\s*\/.*$/, '') || null : null,
  };
}
