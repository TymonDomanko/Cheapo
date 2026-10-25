import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cheapo-q-')), 'q.db');
delete process.env.DISABLE_BACKGROUND_SCRAPES;
process.env.IGA_CONCURRENCY = '3';

test('IGA stores are fetched a few at a time, each once', async () => {
  const iga = await import('../src/iga.js');
  let active = 0;
  let most = 0;
  const runs = [];
  iga.setScrapeRunner(async (id) => {
    runs.push(id);
    active++;
    most = Math.max(most, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return { store: id };
  });
  const ids = ['1', '2', '3', '4', '5', '6', '7'];
  const all = Promise.all([...ids.map((id) => iga.requestScrape(id)), iga.requestScrape('1')]);
  assert.equal(iga.queueStatus().fetching.length, 3);
  const results = await all;
  assert.equal(most, 3, 'three at a time');
  assert.deepEqual(runs.sort(), ids, 'each store once, even if asked twice');
  assert.deepEqual(results.at(-1), { store: '1' }, 'a second request for a store gets the same result');
  assert.deepEqual(iga.queueStatus(), { current: null, fetching: [], waiting: [] });
});

test('a bot check is retried with a fresh session before waiting', async () => {
  const { requestJson } = await import('../src/scrapers/http.js');
  const replies = ['<html>bot check</html>', '{"ok":true}'];
  let renewed = 0;
  const client = { delayMs: 0, request: async () => replies.shift(), renew: async () => { renewed++; } };
  const t = Date.now();
  assert.deepEqual(await requestJson(client, 'https://www.coles.com.au/x.json'), { ok: true });
  assert.equal(renewed, 1);
  assert.ok(Date.now() - t < 1000, 'no back-off wait needed');
});
