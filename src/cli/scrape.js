#!/usr/bin/env node
// Usage: npm run scrape -- [woolworths] [coles] [aldi] [--max-pages=N] [--categories=a,b]
import { scrapeAll, SCRAPERS } from '../scrapers/index.js';

const args = process.argv.slice(2);
const stores = args.filter((a) => !a.startsWith('--'));
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const bad = stores.filter((s) => !SCRAPERS[s]);
if (bad.length) {
  console.error(`Unknown store(s): ${bad.join(', ')}. Choose from: ${Object.keys(SCRAPERS).join(', ')}`);
  process.exit(1);
}

const results = await scrapeAll(stores.length ? stores : undefined, {
  maxPagesPerCategory: flag('max-pages') ? Number(flag('max-pages')) : Infinity,
  onlyCategories: flag('categories')?.split(','),
});
console.table(results);
process.exit(results.some((r) => r.error) ? 1 : 0);
