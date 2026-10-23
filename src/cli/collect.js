#!/usr/bin/env node
// Home collector: crawls stores that block cloud servers (Woolworths, ALDI)
// from your own connection and sends the products to your public site.
//
//   COLLECTOR_SERVER=https://groceries.example.com COLLECTOR_TOKEN=… npm run collect
//   npm run collect -- woolworths aldi --server=https://… --token=…
//   npm run collect -- --cron="0 4 * * *"     # keep running and collect daily
//
// The server must have the same COLLECTOR_TOKEN set.

import cron from 'node-cron';
import { SCRAPERS } from '../scrapers/index.js';
import { sleep } from '../scrapers/http.js';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const server = (flag('server') || process.env.COLLECTOR_SERVER || '').replace(/\/$/, '');
const token = flag('token') || process.env.COLLECTOR_TOKEN;
const schedule = flag('cron') || process.env.COLLECT_CRON;
const named = args.filter((a) => !a.startsWith('--'));
const stores = named.length ? named : (process.env.COLLECT_STORES || 'woolworths,aldi').split(',').map((s) => s.trim());

if (!server || !token) {
  console.error('Set COLLECTOR_SERVER and COLLECTOR_TOKEN (or pass --server= and --token=).');
  process.exit(1);
}
const unknown = stores.filter((s) => !SCRAPERS[s]);
if (unknown.length) {
  console.error(`Unknown store(s): ${unknown.join(', ')}`);
  process.exit(1);
}

/** POST JSON to the site, retrying network hiccups. Uses Node's normal fetch (no scraper proxy). */
async function post(path, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(server + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { fatal: true });
      throw new Error(data.error || `HTTP ${res.status}`);
    } catch (e) {
      if (e.fatal || attempt >= 4) throw e;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

async function collect(store) {
  const { runId } = await post('/api/ingest/runs', { store });
  let sent = 0;
  try {
    for await (const batch of SCRAPERS[store].scrape({ log: (m) => console.log(m) })) {
      if (!batch.length) continue;
      await post(`/api/ingest/runs/${runId}/items`, { items: batch });
      sent += batch.length;
    }
    const r = await post(`/api/ingest/runs/${runId}/finish`, { complete: true });
    console.log(`${store}: sent ${sent} products — ${r.priceChanges} price changes recorded`);
  } catch (e) {
    await post(`/api/ingest/runs/${runId}/finish`, { error: e.message }).catch(() => {});
    throw e;
  }
}

async function collectAll() {
  const results = await Promise.allSettled(stores.map(collect));
  results.forEach((r, i) => r.status === 'rejected' && console.error(`${stores[i]}: failed — ${r.reason?.message}`));
  return results.every((r) => r.status === 'fulfilled');
}

if (schedule) {
  console.log(`Collecting ${stores.join(', ')} for ${server} on schedule "${schedule}"`);
  cron.schedule(schedule, () => collectAll().catch(() => {}), { timezone: process.env.TZ || undefined });
} else {
  process.exit((await collectAll()) ? 0 : 1);
}
