#!/usr/bin/env node
// Records how a supermarket's online shop loads its products, so a scraper
// can be written for it. Opens each page in a real browser, scrolls a little,
// and saves every JSON response (URL, status, a sample of the body) to
// data/capture-<site>-<date>.json. No logins, nothing is bought.
//
//   npx playwright install chromium      (once)
//   npm run capture -- drakes             # built-in starting pages
//   npm run capture -- foodland
//   npm run capture -- https://some-shop.example/search?q=milk

import fs from 'node:fs';
import path from 'node:path';

const PRESETS = {
  drakes: ['https://shop.drakes.com.au/', 'https://shop.drakes.com.au/search?q=milk'],
  foodland: ['https://www.foodland.com.au/', 'https://www.foodland.com.au/shop', 'https://www.foodland.com.au/search?q=milk'],
};

const args = process.argv.slice(2);
const urls = args.flatMap((a) => PRESETS[a.toLowerCase()] || (/^https?:\/\//.test(a) ? [a] : []));
if (!urls.length) {
  console.error(`Usage: npm run capture -- <${Object.keys(PRESETS).join('|')}|url> [more urls]`);
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Needs Playwright: npm install playwright && npx playwright install chromium');
  process.exit(1);
}

const MAX_BODY = 200_000;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await (await browser.newContext({ locale: 'en-AU' })).newPage();
const captured = [];
page.on('response', async (res) => {
  const type = res.headers()['content-type'] || '';
  if (!/json/.test(type)) return;
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* streamed or aborted */
  }
  captured.push({
    url: res.url(),
    method: res.request().method(),
    status: res.status(),
    requestBody: res.request().postData()?.slice(0, 5000) || null,
    bytes: body.length,
    body: body.slice(0, MAX_BODY),
  });
});

const pages = [];
for (const url of urls) {
  console.log(`Opening ${url}`);
  try {
    const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(1200);
    }
    pages.push({ url, finalUrl: page.url(), status: res?.status(), title: await page.title(), html: (await page.content()).slice(0, 300_000) });
  } catch (e) {
    pages.push({ url, error: e.message });
  }
}
await browser.close();

const site = new URL(urls[0]).hostname.replace(/^www\.|^shop\./, '').split('.')[0];
const file = path.resolve(process.env.DATA_DIR || 'data', `capture-${site}-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ capturedAt: new Date().toISOString(), urls, pages, responses: captured }, null, 1));
console.log(`\nSaved ${captured.length} JSON responses from ${pages.length} pages to ${file}`);
console.log('Send that file over and a scraper can be written from it.');
