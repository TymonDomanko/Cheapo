// Coles: the website is a Next.js app, so every category page has a JSON twin
// at /_next/data/<buildId>/en/browse/<slug>.json?page=N (48 products a page).

import { createClient, isBotCheck, BlockedError } from './http.js';
import { parseMultiBuy } from '../promos.js';

const ORIGIN = 'https://www.coles.com.au';
const IMAGE_BASE = 'https://cdn.productimages.coles.com.au/productimages';
// Top-level categories that are duplicates of others or not groceries.
export const SKIP = new Set(
  (process.env.COLES_SKIP_CATEGORIES ?? 'bonus-credit-products,back-to-school,big-pack-value,deliver-more-range,tobacco')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

export const store = 'coles';

// Coles blocks connections that ask for too much (a "Pardon Our Interruption"
// page). Pushing on through a block only makes it last longer, so a blocked
// crawl stops, remembers where it got to (when the caller passes `progress`),
// and the next run carries on from there.
const BLOCKED_MSG = 'Coles is showing a bot check instead of its website, so this connection is blocked for now. It usually lifts within a day if left alone.';

export async function* scrape({ log = console.log, maxPagesPerCategory = Infinity, onlyCategories, progress, result = {}, startedAt } = {}) {
  // After a bot check: a fresh session, then a minute's wait and another. Past that it's a block.
  const client = createClient({ origin: ORIGIN, delayMs: Number(process.env.COLES_DELAY_MS ?? 2500), softBlockWaits: [Number(process.env.COLES_BLOCK_WAIT_MS ?? 60000)] });
  await client.init();
  try {
    const html = await client.getText(ORIGIN + '/');
    const buildId = html.match(/"buildId":"([^"]+)"/)?.[1];
    if (!buildId) throw isBotCheck(html) ? new BlockedError(BLOCKED_MSG) : new Error('Coles: could not find Next.js buildId on home page');
    const data = (p) => `${ORIGIN}/_next/data/${buildId}/en/${p}`;
    const json = async (url) => {
      try {
        return await client.getJson(url);
      } catch (e) {
        if (/bot check|HTTP 403/i.test(e.message)) throw new BlockedError(BLOCKED_MSG);
        throw e;
      }
    };

    const browse = await json(data('browse.json'));
    let cats = (browse.pageProps?.allProductCategories?.catalogGroupView || [])
      .filter((c) => c.level === 1 && c.type === 'CATALOG' && c.productCount > 0 && !SKIP.has(c.seoToken));
    if (onlyCategories?.length) cats = cats.filter((c) => onlyCategories.includes(c.seoToken));
    const partial = !!onlyCategories?.length || Number.isFinite(maxPagesPerCategory);

    // Carry on from an earlier crawl that was blocked part-way (a week at most).
    let state = !partial && progress?.load();
    if (!state || Date.now() - Date.parse(state.passStartedAt) > 7 * 86400000) {
      // startedAt: the time the products are recorded as seen at (the run's start).
      state = { passStartedAt: startedAt || new Date().toISOString(), done: [], cat: null, page: 1, runs: 0 };
    }
    state.runs++;
    const todo = cats.filter((c) => !state.done.includes(c.seoToken));
    log(`coles: ${todo.length} of ${cats.length} categories to go, ~${todo.reduce((n, c) => n + c.productCount, 0)} products${state.done.length ? ` (carrying on from ${state.cat || 'the next category'})` : ''}`);
    const save = () => !partial && progress?.save(state);

    for (const cat of todo) {
      let page = state.cat === cat.seoToken ? state.page : 1;
      let pages = page;
      state.cat = cat.seoToken;
      do {
        let r;
        try {
          r = (await json(data(`browse/${cat.seoToken}.json?slug=${cat.seoToken}&page=${page}`))).pageProps?.searchResults;
        } catch (e) {
          state.page = page;
          save();
          if (e.blocked) throw new BlockedError(`${BLOCKED_MSG} Stopped at ${cat.name}, page ${page}; the next refresh carries on from there.`);
          throw e;
        }
        if (!r) break;
        pages = Math.ceil((r.noOfResults || 0) / (r.pageSize || 48));
        const items = (r.results || []).filter((x) => x._type === 'PRODUCT').map((x) => mapProduct(x, cat.name));
        log(`coles: ${cat.seoToken} page ${page}/${pages} (${items.length})`);
        yield items;
        page++;
        state.page = page;
        save();
      } while (page <= pages && page <= maxPagesPerCategory);
      state.done.push(cat.seoToken);
      state.cat = null;
      state.page = 1;
      save();
    }
    // Every category done: the whole shop has been seen since the crawl began (perhaps several runs ago).
    if (!partial) {
      result.complete = true;
      result.seenSince = state.passStartedAt;
      progress?.save(null);
    }
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
