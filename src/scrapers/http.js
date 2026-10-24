// HTTP client used by the scrapers. Two modes:
//  - "fetch" (default): plain Node fetch with browser-like headers and a cookie jar.
//  - "browser": runs every request from inside a real Chromium page on the
//    store's own origin (via Playwright). Slower, but survives bot protection
//    that rejects non-browser clients. Set SCRAPE_MODE=browser to use it.

// Node's fetch ignores proxy env vars; honour them for scraper requests so this works behind a proxy.
// undici is optional so the home collector also runs as a single executable with no packages.
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
// (Without undici, Node 22.21+ can still use the proxy for every request when NODE_USE_ENV_PROXY=1.)
const dispatcher = PROXY && process.env.NODE_USE_ENV_PROXY !== '1' ? await proxyAgent(PROXY) : undefined;

async function proxyAgent(url) {
  try {
    const { ProxyAgent } = await import('undici');
    return new ProxyAgent(url);
  } catch {
    console.warn('HTTPS_PROXY is set but the undici package isn\'t available; set NODE_USE_ENV_PROXY=1 to use it.');
    return undefined;
  }
}

const UA = process.env.SCRAPE_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A bot-protection page (Imperva / Incapsula, used by Coles) instead of the real thing. */
export const isBotCheck = (text) => /Pardon Our Interruption|_Incapsula_Resource|Request unsuccessful\. Incapsula/i.test(String(text).slice(0, 5000));

/** The shop is blocking this connection: stop and try again later rather than keep asking. */
export class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.blocked = true;
  }
}

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}${/access denied/i.test(body || '') ? ' (blocked by bot protection — try SCRAPE_MODE=browser or run from a home connection)' : ''}`);
    this.status = status;
  }
}

// Bot protection sometimes answers with an HTML challenge page (status 200)
// instead of JSON. A fresh session often gets straight through (Coles limits
// each IP to a burst of requests, then challenges); if not, back off and try
// again a few times before giving up.
const SOFT_BLOCK_WAITS = [15000, 45000, 120000];

export async function requestJson(client, url, opts) {
  let renewed = false;
  for (let attempt = 0; ; ) {
    const text = await client.request(url, opts);
    await sleep(client.delayMs);
    try {
      return JSON.parse(text);
    } catch {
      const host = new URL(url).host;
      if (!renewed && client.renew) {
        renewed = true;
        console.warn(`Got non-JSON response from ${host}; trying a fresh session`);
        await client.renew();
        continue;
      }
      const waits = client.softBlockWaits || SOFT_BLOCK_WAITS;
      if (attempt >= waits.length) {
        throw new Error(`Expected JSON from ${url} but got ${text.trim().startsWith('<') ? 'an HTML page (likely a bot check)' : 'invalid data'}`);
      }
      console.warn(`Got non-JSON response from ${host}; backing off ${waits[attempt] / 1000}s`);
      await sleep(waits[attempt++]);
      renewed = false; // after waiting, a fresh session is worth another try
    }
  }
}

/** @param {{softBlockWaits?: number[]}} opts softBlockWaits: how long to wait between tries after a bot check */
export function createClient({ origin, mode = process.env.SCRAPE_MODE || 'fetch', delayMs = 400, extraHeaders = {}, softBlockWaits }) {
  const client = mode === 'browser'
    ? new BrowserClient(origin, delayMs, extraHeaders)
    : new FetchClient(origin, delayMs, extraHeaders);
  client.softBlockWaits = softBlockWaits;
  return client;
}

class FetchClient {
  constructor(origin, delayMs, extraHeaders) {
    this.origin = origin;
    this.delayMs = delayMs;
    this.extraHeaders = extraHeaders;
    this.cookies = new Map();
  }

  async init() {
    // Visiting the home page first collects the session/bot-manager cookies
    // that the stores' JSON APIs expect.
    try {
      await this.request(this.origin + '/', { accept: 'text/html' });
    } catch {
      /* non-fatal: some APIs work without cookies */
    }
  }

  /** Start a new session: forget cookies and collect fresh ones. */
  async renew() {
    this.cookies.clear();
    await this.init();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async request(url, { method = 'GET', body, accept = 'application/json', headers = {} } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(1000 * 2 ** attempt);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'User-Agent': UA,
            Accept: accept,
            'Accept-Language': 'en-AU,en;q=0.9',
            Origin: this.origin,
            Referer: this.origin + '/',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
            ...this.extraHeaders,
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: 'follow',
          dispatcher,
        });
        this.storeCookies(res);
        const text = await res.text();
        if (!res.ok) {
          const err = new HttpError(res.status, url, text);
          // 4xx other than rate-limit won't fix itself by retrying.
          if (res.status !== 429 && res.status < 500) throw Object.assign(err, { fatal: true });
          throw err;
        }
        return text;
      } catch (e) {
        lastErr = e;
        if (e.fatal) break;
      }
    }
    throw lastErr;
  }

  async getText(url) {
    const t = await this.request(url, { accept: 'text/html' });
    await sleep(this.delayMs);
    return t;
  }

  getJson(url, headers) {
    return requestJson(this, url, { headers });
  }

  postJson(url, body, headers) {
    return requestJson(this, url, { method: 'POST', body, headers });
  }

  async close() {}
}

class BrowserClient {
  constructor(origin, delayMs, extraHeaders) {
    this.origin = origin;
    this.delayMs = delayMs;
    this.extraHeaders = extraHeaders;
  }

  async init() {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error('SCRAPE_MODE=browser needs Playwright: run `npm install playwright && npx playwright install chromium`');
    }
    this.browser = await chromium.launch({
      headless: process.env.SCRAPE_HEADLESS !== 'false',
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    const ctx = await this.browser.newContext({ locale: 'en-AU', userAgent: UA });
    this.page = await ctx.newPage();
    await this.page.goto(this.origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
  }

  async request(url, { method = 'GET', body, accept = 'application/json', headers = {} } = {}) {
    const res = await this.page.evaluate(
      async ({ url, method, body, headers }) => {
        const r = await fetch(url, { method, body, headers, credentials: 'include' });
        return { status: r.status, text: await r.text() };
      },
      {
        url,
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: { Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}), ...this.extraHeaders, ...headers },
      },
    );
    if (res.status >= 400) throw new HttpError(res.status, url, res.text);
    return res.text;
  }

  async getText(url) {
    const t = await this.request(url, { accept: 'text/html' });
    await sleep(this.delayMs);
    return t;
  }

  getJson(url, headers) {
    return requestJson(this, url, { headers });
  }

  postJson(url, body, headers) {
    return requestJson(this, url, { method: 'POST', body, headers });
  }

  async close() {
    await this.browser?.close();
  }
}

/**
 * Crawl each category with `crawl(cat)` (an async generator of batches). A
 * category that keeps failing (say a bot check that won't clear) is skipped so
 * the rest of the shop is still saved; the run then ends with an error naming
 * what was missed, so it isn't treated as complete. Three failures in a row
 * means the whole site is blocking us, so it stops there.
 */
export async function* eachCategory(store, cats, log, crawl) {
  const failed = [];
  let streak = 0;
  for (const cat of cats) {
    const name = cat.slug || cat.seoToken || cat.name;
    try {
      yield* crawl(cat);
      streak = 0;
    } catch (e) {
      failed.push(name);
      log(`${store}: skipped ${name} — ${e.message}`);
      if (++streak >= 3) throw new Error(`stopped after ${streak} categories in a row failed (last: ${e.message})`);
    }
  }
  if (failed.length) throw new Error(`couldn't fetch ${failed.length} of ${cats.length} categories (${failed.join(', ')}); everything else was saved`);
}

/**
 * Like eachCategory, but crawls several categories at once, each worker with
 * its own client (its own session). Batches are yielded as they arrive. A
 * category that keeps failing is skipped; three failures with no category
 * finishing in between stop the crawl.
 * @param {{workers?: number, log: Function, newClient: () => Promise<object>, crawl: (client, cat) => AsyncIterable}} opts
 */
export async function* crawlInParallel(store, cats, { workers = 2, log, newClient, crawl }) {
  const queue = [...cats];
  const ready = [];
  const failed = [];
  let streak = 0;
  let fatal = null;
  let finished = false;
  let wake = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  async function worker() {
    let client;
    try {
      client = await newClient();
      while (queue.length && !fatal) {
        const cat = queue.shift();
        const name = cat.slug || cat.seoToken || cat.name;
        try {
          for await (const batch of crawl(client, cat)) {
            if (fatal) return;
            ready.push(batch);
            notify();
          }
          streak = 0;
        } catch (e) {
          failed.push(name);
          log(`${store}: skipped ${name} — ${e.message}`);
          if (++streak >= 3) fatal = new Error(`stopped after ${streak} categories failed in a row (last: ${e.message})`);
        }
      }
    } catch (e) {
      fatal ||= e;
    } finally {
      await client?.close?.();
      notify();
    }
  }
  const all = Promise.all(Array.from({ length: Math.max(1, Math.min(workers, cats.length)) }, worker)).then(() => {
    finished = true;
    notify();
  });
  while (true) {
    if (ready.length) {
      yield ready.shift();
      continue;
    }
    if (finished) break;
    await new Promise((resolve) => {
      wake = resolve;
    });
  }
  await all;
  if (fatal) throw fatal;
  if (failed.length) throw new Error(`couldn't fetch ${failed.length} of ${cats.length} categories (${failed.join(', ')}); everything else was saved`);
}
