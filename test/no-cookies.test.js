// A shop whose bot protection refuses requests carrying the cookies it gives a
// non-browser (Dan Murphy's) is asked without any.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createClient } = await import('../src/scrapers/http.js');

test('a client without cookies skips the home page and never sends any', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    seen.push({ path: new URL(url).pathname, cookie: opts.headers.Cookie });
    return new Response('{"ok":true}', { status: 200, headers: { 'set-cookie': '_abck=bot; Path=/' } });
  });
  const plain = createClient({ origin: 'https://shop.example', delayMs: 0, cookies: false });
  await plain.init();
  await plain.getJson('https://api.shop.example/a');
  await plain.getJson('https://api.shop.example/b');
  assert.deepEqual(seen, [{ path: '/a', cookie: undefined }, { path: '/b', cookie: undefined }]);

  seen.length = 0;
  const usual = createClient({ origin: 'https://shop.example', delayMs: 0 });
  await usual.init();
  await usual.getJson('https://api.shop.example/a');
  assert.deepEqual(seen.map((s) => [s.path, s.cookie]), [['/', undefined], ['/a', '_abck=bot']], 'other shops still collect cookies first');
});
