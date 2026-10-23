// HTTP client used by the scrapers. Two modes:
//  - "fetch" (default): plain Node fetch with browser-like headers and a cookie jar.
//  - "browser": runs every request from inside a real Chromium page on the
//    store's own origin (via Playwright). Slower, but survives bot protection
//    that rejects non-browser clients. Set SCRAPE_MODE=browser to use it.

import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Node's fetch ignores proxy env vars; honour them so this works behind a proxy.
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
if (PROXY) setGlobalDispatcher(new ProxyAgent(PROXY));

const UA = process.env.SCRAPE_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}${/access denied/i.test(body || '') ? ' (blocked by bot protection — try SCRAPE_MODE=browser or run from a home connection)' : ''}`);
    this.status = status;
  }
}

// Bot protection sometimes answers with an HTML challenge page (status 200)
// instead of JSON. Back off and try again a few times before giving up.
const SOFT_BLOCK_WAITS = [15000, 45000, 120000];

async function requestJson(client, url, opts) {
  for (let attempt = 0; ; attempt++) {
    const text = await client.request(url, opts);
    await sleep(client.delayMs);
    try {
      return JSON.parse(text);
    } catch {
      if (attempt >= SOFT_BLOCK_WAITS.length) {
        throw new Error(`Expected JSON from ${url} but got ${text.trim().startsWith('<') ? 'an HTML page (likely a bot check)' : 'invalid data'}`);
      }
      console.warn(`Got non-JSON response from ${new URL(url).host}; backing off ${SOFT_BLOCK_WAITS[attempt] / 1000}s`);
      await sleep(SOFT_BLOCK_WAITS[attempt]);
    }
  }
}

export function createClient({ origin, mode = process.env.SCRAPE_MODE || 'fetch', delayMs = 400, extraHeaders = {} }) {
  return mode === 'browser'
    ? new BrowserClient(origin, delayMs, extraHeaders)
    : new FetchClient(origin, delayMs, extraHeaders);
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
