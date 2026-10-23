#!/usr/bin/env node
// Home collector: crawls stores that block cloud servers (Woolworths, ALDI)
// from your own connection and sends the products to your public site.
//
// Easiest: download it from your site's Admin page (Site settings → Home
// collector) — a single program for Windows or Linux, or a zip with
// start.bat / start.sh for any computer with Node.js. Or from this repo:
//   COLLECTOR_SERVER=https://groceries.example.com COLLECTOR_TOKEN=… npm run collect
//   npm run collect -- woolworths aldi --server=https://… --token=…
//   npm run collect -- --cron="0 4 * * *"     # keep running and collect daily
//
// A downloaded collector keeps itself up to date: before each collection it
// asks the site for the latest version and, if it's different, downloads it,
// checks it, replaces its own files and restarts (exit code 75). The single
// program (src/collector-launcher.cjs) does the downloading itself and only
// needs this to ask for the restart.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectorVersion, COLLECTOR_CODE } from '../collector-files.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESTART = 75;

// Settings from .env next to the collector (a downloaded one has it filled in).
loadEnvFile(path.join(ROOT, '.env'));

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const server = (flag('server') || process.env.COLLECTOR_SERVER || '').replace(/\/$/, '');
const token = flag('token') || process.env.COLLECTOR_TOKEN;
const schedule = flag('cron') || process.env.COLLECT_CRON;
const named = args.filter((a) => !a.startsWith('--'));
const stores = named.length ? named : (process.env.COLLECT_STORES || 'woolworths,aldi').split(',').map((s) => s.trim());

// How this copy runs: a downloaded bundle can update itself; inside the Docker
// image or a git checkout it can't (pull the new image / code instead).
const MODE = process.env.COLLECTOR_MODE === 'exe' ? 'exe'
  : fs.existsSync(path.join(ROOT, '.collector-bundle')) ? 'bundle' : fs.existsSync('/.dockerenv') ? 'docker' : 'source';
const VERSION = collectorVersion((p) => fs.readFileSync(path.join(ROOT, p), 'utf8'));

// Scrapers read proxy settings when loaded, so load them after .env.
const { SCRAPERS } = await import('../scrapers/registry.js');
const { sleep } = await import('../scrapers/http.js');
const cron = await import('../mini-cron.js');

if (!server || !token) {
  console.error('Set COLLECTOR_SERVER and COLLECTOR_TOKEN (in .env, or pass --server= and --token=).');
  process.exit(1);
}
const unknown = stores.filter((s) => !SCRAPERS[s]);
if (unknown.length) {
  console.error(`Unknown store(s): ${unknown.join(', ')}`);
  process.exit(1);
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  'X-Collector-Version': VERSION,
  'X-Collector-Mode': MODE,
});

/** Talk to the site, retrying network hiccups. Uses Node's normal fetch (no scraper proxy). */
async function call(method, urlPath, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(server + urlPath, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
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
const post = (p, body) => call('POST', p, body);

// ---------------------------------------------------------------- staying up to date

/** Returns true if this copy was replaced and should restart. */
async function updateIfNeeded() {
  let latest;
  try {
    latest = (await call('GET', '/api/collector/latest')).version;
  } catch (e) {
    console.warn(`Couldn't check for updates: ${e.message}`);
    return false;
  }
  if (latest === VERSION) return false;
  if (MODE === 'exe' && process.env.AUTO_UPDATE !== 'false') {
    console.log(`Updating collector ${VERSION} → ${latest}…`);
    return true; // the launcher fetches the new code when it restarts us
  }
  if (MODE !== 'bundle' || process.env.AUTO_UPDATE === 'false') {
    console.warn(`A newer collector is available (${latest}; this is ${VERSION}). `
      + (MODE === 'docker' ? 'Run: docker compose pull && docker compose up -d' : MODE === 'source' ? 'Pull the latest code.' : 'Download it from the Admin page, or set AUTO_UPDATE=true.'));
    return false;
  }
  console.log(`Updating collector ${VERSION} → ${latest}…`);
  const bundle = await call('GET', '/api/collector/bundle');
  // Make sure we got the whole, matching code before touching anything.
  const check = collectorVersion((p) => bundle.files[p] ?? '');
  if (check !== bundle.version || COLLECTOR_CODE.some((p) => typeof bundle.files[p] !== 'string')) {
    console.error('Update download looked wrong; keeping the current version.');
    return false;
  }
  const oldPackage = fs.existsSync(path.join(ROOT, 'package.json')) ? fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8') : '';
  for (const [rel, text] of Object.entries(bundle.files)) {
    const dest = path.resolve(ROOT, rel);
    if (!dest.startsWith(ROOT + path.sep) || rel === '.env') continue; // never write outside the folder or over settings
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(`${dest}.tmp`, text);
    fs.renameSync(`${dest}.tmp`, dest);
  }
  if (bundle.files['package.json'] !== oldPackage) {
    console.log('Installing updated dependencies…');
    spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  console.log('Updated — restarting.');
  return true;
}

// ---------------------------------------------------------------- collecting

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

async function run() {
  if (await updateIfNeeded()) process.exit(RESTART);
  const results = await Promise.allSettled(stores.map(collect));
  results.forEach((r, i) => r.status === 'rejected' && console.error(`${stores[i]}: failed — ${r.reason?.message}`));
  return results.every((r) => r.status === 'fulfilled');
}

console.log(`Home collector ${VERSION} (${MODE}) for ${server}: ${stores.join(', ')}`);
if (schedule) {
  console.log(`Collecting on schedule "${schedule}"${process.env.TZ ? ` (${process.env.TZ})` : ''}`);
  cron.schedule(schedule, () => run().catch((e) => console.error(e.message)), { timezone: process.env.TZ || undefined });
  if (process.env.COLLECT_ON_START === 'true') run().catch((e) => console.error(e.message));
  else if (await updateIfNeeded()) process.exit(RESTART);
} else {
  process.exit((await run()) ? 0 : 1);
}
