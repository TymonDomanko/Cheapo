// One Coles page at a time, for the steady refresh (src/coles-live.js). The
// server decides which page comes next (a "job"); this fetches it. The server
// and helpers' collectors use the same code, each with its own connection.
//
// Jobs:
//   { kind: 'search', q }                 Coles' own search, first page
//   { kind: 'specials', page }            everything on special
//   { kind: 'index' }                     the list of departments
//   { kind: 'browse', dept, name, page }  one page of a department
//   { kind: 'barcode', url }              a product page, for its barcode
// Each result says how many requests it took (a new session costs one more).
// A job's `store` is the Coles store whose prices to get (the fulfillmentStoreId
// cookie Coles' own site sets when you choose a store); without one, Coles'
// default store.

import { createClient, isBotCheck, BlockedError } from './http.js';
import { mapProduct } from './coles.js';

export const ORIGIN = 'https://www.coles.com.au';

/** A connection to Coles that fetches jobs. */
export function colesPages(makeClient = () => createClient({ origin: ORIGIN, delayMs: 0, softBlockWaits: [] })) {
  let session = null; // { client, buildId, store }
  let requests = 0;

  async function getSession(store = null) {
    if (session && session.store === store) return session;
    const client = makeClient();
    if (store) client.pinCookie?.('fulfillmentStoreId', store);
    if (client.constructor.name === 'BrowserClient') await client.init(); // SCRAPE_MODE=browser
    requests++;
    const html = await client.request(`${ORIGIN}/`, { accept: 'text/html' });
    const buildId = html.match(/"buildId":"([^"]+)"/)?.[1];
    if (!buildId) throw new BlockedError(isBotCheck(html) ? 'Coles is showing a bot check' : 'Coles: could not find the site version');
    session = { client, buildId, store };
    return session;
  }

  let wanted = null; // this job's store

  /** One of Coles' data pages (one request). */
  async function data(path) {
    const s = await getSession(wanted);
    requests++;
    let text;
    try {
      text = await s.client.request(`${ORIGIN}/_next/data/${s.buildId}/en/${path}`);
    } catch (e) {
      // A new version of the site moves the data pages: start a new session next time.
      if (e.status === 404) session = null;
      if (e.status === 403) throw new BlockedError('Coles refused the request (HTTP 403)');
      throw e;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw isBotCheck(text) ? new BlockedError('Coles is showing a bot check') : new Error(`Coles sent something unexpected for ${path}`);
    }
  }

  /** A page of products, mapped ready to save. */
  function products(json, category = null) {
    const r = json?.pageProps?.searchResults;
    if (!r) return { items: [], pages: 0 };
    const items = (r.results || []).filter((x) => x._type === 'PRODUCT').map((x) => mapProduct(x, category));
    return { items, pages: Math.ceil((r.noOfResults || 0) / (r.pageSize || 48)) };
  }

  async function fetchJob(job) {
    if (job.kind === 'search') return products(await data(`search/products.json?q=${encodeURIComponent(job.q)}`));
    if (job.kind === 'specials') return products(await data(`on-special.json?page=${Number(job.page) || 1}`));
    if (job.kind === 'browse') {
      const dept = encodeURIComponent(job.dept);
      return products(await data(`browse/${dept}.json?slug=${dept}&page=${Number(job.page) || 1}`), job.name || null);
    }
    if (job.kind === 'index') {
      const browse = await data('browse.json');
      const cats = (browse.pageProps?.allProductCategories?.catalogGroupView || [])
        .filter((c) => c.level === 1 && c.type === 'CATALOG' && c.productCount > 0)
        .map((c) => ({ dept: c.seoToken, name: c.name, products: c.productCount }));
      return { cats };
    }
    if (job.kind === 'barcode') {
      try {
        const path = new URL(job.url).pathname.replace(/^\//, ''); // product/<slug>-<id>
        let json = await data(`${path}.json`);
        let canonical = null;
        const redirect = json?.pageProps?.__N_REDIRECT;
        if (redirect) {
          canonical = ORIGIN + redirect;
          json = await data(`${redirect.replace(/^\//, '')}.json`);
        }
        return { gtin: JSON.stringify(json).match(/"gtin":"(\d{8,14})"/)?.[1] || null, canonical };
      } catch (e) {
        if (e.blocked) throw e;
        return { gtin: null, canonical: null }; // no page for it (gone, or moved)
      }
    }
    throw new Error(`Unknown Coles job: ${job.kind}`);
  }

  return {
    /** Fetch a job. Returns its result plus `requests`; throws (e.blocked) if Coles is blocking. */
    async run(job) {
      requests = 0;
      wanted = job.store ? String(job.store) : null;
      try {
        return { ...(await fetchJob(job)), requests };
      } catch (e) {
        if (e.blocked) session = null;
        e.requests = requests;
        throw e;
      }
    },
    reset() {
      session = null;
    },
  };
}
