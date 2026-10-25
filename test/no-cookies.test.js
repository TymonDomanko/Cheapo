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

test('a client can make its requests with curl (a shop that refuses Node’s own), or Node’s without curl', async () => {
  const http = await import('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ method: req.method, ua: req.headers['user-agent'], origin: req.headers.origin, type: req.headers['content-type'], body });
      if (req.url === '/gone') return void res.writeHead(404).end('no');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":"yes ✓"}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
  process.env.NO_PROXY = '127.0.0.1';
  try {
    const c = createClient({ origin: 'https://shop.example', delayMs: 0, cookies: false, curl: true });
    assert.deepEqual(await c.postJson(`${base}/api`, { department: 'beer' }), { ok: 'yes ✓' });
    assert.deepEqual(seen[0], { method: 'POST', ua: seen[0].ua, origin: 'https://shop.example', type: 'application/json', body: '{"department":"beer"}' });
    assert.match(seen[0].ua, /Chrome/);
    await assert.rejects(c.getJson(`${base}/gone`), (e) => e.status === 404);
  } finally {
    Object.assign(process.env, saved);
    server.close();
  }
});
