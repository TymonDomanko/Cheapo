// Dan Murphy's and BWS (Endeavour Group) share one website API, much like
// Woolworths': POST/GET /apis/ui/Browse for a department, 1–100 products a page.
// Some ranges are only listed as a product group instead (Dan Murphy's
// premixes: POST /apis/ui/ProductGroup/Products/premix).
// Liquor comes in packs, so each way a product is sold (a bottle, a 6-pack, a
// case of 24) becomes its own product, sized "24 x 375mL", so equal packs are
// compared and unit prices work.
//   Dan Murphy's: one record per product, with a price for each pack
//     (caseprice, singleprice, inanysixprice, promoprice);
//   BWS: one record per pack, grouped in bundles, with its own price and
//     unit count (productunitquantity).

import { createClient } from './http.js';

const PAGE_SIZE = 60;

const volumeOf = (...texts) => {
  for (const t of texts) {
    const m = String(t || '').match(/(\d+(?:\.\d+)?)\s*(ml|l)\b/i);
    if (m) return `${m[1]}${m[2].toLowerCase() === 'l' ? 'L' : 'mL'}`;
  }
  return null;
};
const sized = (count, volume) => (volume ? (count > 1 ? `${count} x ${volume}` : volume) : count > 1 ? `${count} pack` : null);
const details = (p) => Object.fromEntries((p.AdditionalDetails || []).map((a) => [a.Name, a.Value]));
const plain = (s) => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
/** The shop's own category if it says what drink it is ("Red Wine"), else the department's ("Spirits" for "Standard"). */
export const liquorCategory = (own, department) => (own && LIQUOR_WORDS.test(own) ? own : department);
// Words that make a category count as alcohol (src/aisles.js); "RTD" or "Sparkling" alone wouldn't.
const LIQUOR_WORDS = /beer|wine|cider|spirits|vodka|whisk|\bgin\b|\brum\b|bourbon|champagne|lager|\bale\b|liqueur|premix/i;

/**
 * A liquor chain on the Endeavour platform.
 * @param {{store: string, origin: string, api: string, departments: {key: string, name: string, department?: string, subDepartment?: string, group?: string}[], method: 'GET'|'POST', productUrl: (p) => string}} cfg
 */
export function endeavour(cfg) {
  const delayMs = () => Number(process.env[`${cfg.store.toUpperCase()}_DELAY_MS`] ?? 800);

  /** The departments to crawl (fixed: the API has no list of them). */
  async function departments() {
    return cfg.departments.map((d) => ({ ...d, slug: d.key }));
  }

  async function page(client, dept, n) {
    if (dept.group) {
      const json = await client.postJson(`${cfg.api}/ProductGroup/Products/${encodeURIComponent(dept.group)}`, {
        pageSize: PAGE_SIZE, pageNumber: n, sortType: 'Name', Location: 'ProductGroup', Filters: [], ShowOnlyAvailable: false,
      });
      return { TotalRecordCount: json.TotalRecordCount, Bundles: json.Items };
    }
    if (cfg.method === 'GET') {
      const qs = new URLSearchParams({
        Department: dept.department, ...(dept.subDepartment ? { SubDepartment: dept.subDepartment } : {}),
        Location: `/${dept.department}${dept.subDepartment ? `/${dept.subDepartment.replace(/ /g, '-')}` : ''}`,
        PageNumber: String(n), PageSize: String(PAGE_SIZE), SortType: 'Name',
      });
      return client.getJson(`${cfg.api}/Browse?${qs}`);
    }
    return client.postJson(`${cfg.api}/Browse`, {
      department: dept.department, ...(dept.subDepartment ? { subDepartment: dept.subDepartment } : {}),
      filters: [], pageNumber: n, pageSize: PAGE_SIZE, sortType: 'Name',
    });
  }

  async function* scrape({ log = console.log, maxPagesPerCategory = Infinity, onlyCategories, categories } = {}) {
    let cats = categories || await departments();
    if (onlyCategories?.length) cats = cats.filter((c) => onlyCategories.includes(c.key));
    const client = createClient({ origin: cfg.origin, delayMs: delayMs() });
    await client.init();
    try {
      for (const dept of cats) {
        let n = 1;
        let pages = 1;
        do {
          const json = await page(client, dept, n);
          pages = Math.ceil((json.TotalRecordCount || 0) / PAGE_SIZE);
          const items = (json.Bundles || []).flatMap((b) => mapBundle(b, dept.name));
          log(`${cfg.store}: ${dept.key} page ${n}/${pages} (${items.length})`);
          yield items;
          if (!json.Bundles?.length) break;
          n++;
        } while (n <= pages && n <= maxPagesPerCategory);
      }
    } finally {
      await client.close();
    }
  }

  /** Every way the products in a bundle are sold, as products. */
  function mapBundle(bundle, category) {
    const products = bundle.Products || [];
    const vol = volumeOf(...products.flatMap((p) => [details(p).liquorsize, details(p).webliquorsize, p.PackageSize, details(p).producttitle]));
    return products.flatMap((p) => (p.Prices ? packsFromPrices(p, category) : [packFromRecord(p, category, vol)])).filter(Boolean);
  }

  // Dan Murphy's: one record, a price per pack.
  function packsFromPrices(p, category) {
    const ad = details(p);
    const brand = ad.webbrandname || null;
    const title = plain(ad.webtitle || ad.producttitle || p.Description);
    const name = brand && !title.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${title}` : title;
    const vol = volumeOf(ad.webliquorsize, p.PackageSize, title);
    const promo = p.Prices.promoprice;
    const out = [];
    const add = (key, count, price, { anySix = 0 } = {}) => {
      if (!(price?.Value > 0)) return;
      const onPromo = promo && promo.Message === price.Message && promo.Value > 0;
      const member = onPromo && promo.IsMemberOffer;
      out.push({
        store_product_id: `${p.Stockcode}-${key}`,
        name: count > 1 ? `${name} ${key === 'case' ? 'Case' : 'Pack'}` : name,
        brand,
        size_text: sized(count, vol),
        category: liquorCategory(ad.webproducttype, category),
        image_url: p.MediumImageFile || p.SmallImageFile || null,
        product_url: cfg.productUrl(p),
        price: onPromo && !member ? promo.Value : price.Value,
        was_price: onPromo && !member && promo.BeforePromotion > promo.Value ? promo.BeforePromotion : null,
        on_special: !!(onPromo && !member),
        member_price: member ? promo.Value : null,
        multi_qty: anySix > 0 ? 6 : null,
        multi_price: anySix > 0 ? Math.round(anySix * 6 * 100) / 100 : null,
        available: p.IsPurchasable !== false,
      });
    };
    const count = (msg) => Number(String(msg || '').match(/\((\d+)\)/)?.[1]) || 1;
    const { caseprice, singleprice, inanysixprice } = p.Prices;
    if (caseprice) add('case', count(caseprice.Message), caseprice);
    const singleIsEach = singleprice && !/pack/i.test(singleprice.Message);
    if (singleprice && !singleIsEach) add('pack', count(singleprice.Message), singleprice);
    // A single bottle: its own price, or the in-store each price; "in any six" is a multi-buy on it.
    const each = singleIsEach ? singleprice : inanysixprice && /each/i.test(inanysixprice.Message) ? inanysixprice : null;
    const anySix = /any six/i.test(inanysixprice?.Message || '') ? inanysixprice.Value : 0;
    if (each) add('each', 1, each, { anySix });
    return out;
  }

  // BWS: one record per pack.
  function packFromRecord(p, category, bundleVolume) {
    const ad = details(p);
    const count = Number(ad.productunitquantity) || 1;
    const brand = p.BrandName ? plain(p.BrandName) : null;
    const title = plain(ad.producttitle || p.Title || p.Name || p.Description);
    const name = brand && !title.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${title}` : title;
    const vol = volumeOf(ad.liquorsize, p.PackageSize, title) || bundleVolume;
    const was = Number(p.WasPrice) > Number(p.Price) ? Number(p.WasPrice) : null;
    return {
      store_product_id: String(p.Stockcode),
      name: count > 1 ? `${name} ${/case/i.test(ad.webpacktype) ? 'Case' : 'Pack'}` : name,
      brand,
      size_text: sized(count, vol),
      category,
      image_url: p.Images?.[0]?.MediumImageFile || `https://edgmedia.bws.com.au/bws/media/products/${p.Stockcode}-1.png`,
      product_url: cfg.productUrl(p),
      price: Number(p.Price) > 0 ? Number(p.Price) : null,
      was_price: was,
      on_special: !!was || !!p.IsOnSpecial,
      // IsAvailable is stock at BWS's default store (about two in three say no), not whether BWS sells it.
      available: Number(p.Price) > 0,
    };
  }

  return { store: cfg.store, departments, scrape, mapBundle };
}
