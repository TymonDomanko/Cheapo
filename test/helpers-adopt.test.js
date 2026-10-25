// The single collector token from before helpers becomes a helper called
// "Home collector", so a collector that's already running keeps working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cheapo-adopt-')), 'test.db');

const { getDb } = await import('../src/db.js');
const helpers = await import('../src/helpers.js');

test('the old token, saved in Site settings, becomes a helper with its last connection', () => {
  const d = getDb();
  const old = 'an-old-site-collector-token-1234567890';
  d.prepare("INSERT INTO app_settings (key, value) VALUES ('cfg:COLLECTOR_TOKEN', ?)").run(old);
  d.prepare("INSERT INTO app_settings (key, value) VALUES ('collector:last', ?)").run(JSON.stringify({ version: 'abc123', mode: 'exe', at: '2026-10-24T20:00:00.000Z' }));

  const who = helpers.identify(old);
  assert.equal(who.name, 'Home collector', 'the running collector is let in, now as a helper');
  const [h] = helpers.list();
  assert.deepEqual([h.name, h.version, h.mode, h.last_seen_at], ['Home collector', 'abc123', 'exe', '2026-10-24T20:00:00.000Z']);
  assert.equal(d.prepare("SELECT 1 FROM app_settings WHERE key IN ('cfg:COLLECTOR_TOKEN', 'collector:last')").get(), undefined, 'the old setting is gone');

  // It's an ordinary helper now: a new token (a fresh download) replaces the old one for good.
  const fresh = helpers.newToken(h.id);
  assert.equal(helpers.identify(old), null);
  assert.equal(helpers.identify(fresh).name, 'Home collector');
  process.env.COLLECTOR_TOKEN = old; // even if it's still in .env, it isn't adopted again
  helpers.adoptSiteToken();
  assert.equal(helpers.identify(old), null);
  assert.equal(helpers.list().length, 1);
  delete process.env.COLLECTOR_TOKEN;
});
