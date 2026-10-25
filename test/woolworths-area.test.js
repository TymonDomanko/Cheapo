// Which Woolworths store a connection is given, and its name from the store finder.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { area } = await import('../src/scrapers/woolworths.js');

test('the store Woolworths gives this connection, named from the store finder', async (t) => {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    asked.push(u.pathname + u.search);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/') return new Response('<html></html>', { status: 200 });
    if (u.pathname === '/api/ui/v2/bootstrap') return json({ GetDeliveryInfoRequest: { FulfilmentStoreId: 1101, Address: { PostalCode: '2121' } } });
    if (u.pathname === '/apis/ui/StoreLocator/Stores') {
      const pc = u.searchParams.get('postcode');
      if (pc === '2121') return json({ Stores: [{ StoreNo: '1200', Name: 'Eastwood', State: 'NSW' }] });
      if (pc === '2000') return json({ Stores: [{ StoreNo: '1200', Name: 'Eastwood', State: 'NSW' }, { StoreNo: '1101', Name: 'Carlingford Court', State: 'NSW' }] });
      return json({ Stores: [] });
    }
    return new Response('', { status: 404 });
  });
  assert.deepEqual(await area(), { id: '1101', name: 'Carlingford Court, NSW' });
  const searches = asked.filter((a) => a.startsWith('/apis/ui/StoreLocator'));
  assert.match(searches[0], /postcode=2121/, 'near the postcode the site has for this visitor first');
  assert.equal(searches.length, 2, 'then the capitals, stopping once found');
  // Remembered: no searching the next time.
  await area();
  assert.equal(asked.filter((a) => a.startsWith('/apis/ui/StoreLocator')).length, 2);
});
