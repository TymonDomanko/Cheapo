// Liquor shops' products: each way of buying (bottle, pack, case) becomes a
// product with a size, from trimmed copies of the shops' real responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const dm = await import('../src/scrapers/danmurphys.js');
const bws = await import('../src/scrapers/bws.js');
const ll = await import('../src/scrapers/liquorland.js');

const d = (pairs) => Object.entries(pairs).map(([Name, Value]) => ({ Name, Value }));
const short = (p) => `${p.name} | ${p.size_text} | ${p.price}${p.was_price ? ` was ${p.was_price}` : ''}${p.multi_qty ? ` | ${p.multi_qty} for ${p.multi_price}` : ''}`;

test('Dan Murphy’s: a case, a pack and a single from one record, with the promo on the right one', () => {
  const bundle = {
    Products: [{
      Stockcode: '256271', UrlFriendlyName: '4-pines-pale-ale-can-375ml', PackageSize: '375ML', IsPurchasable: true,
      MediumImageFile: 'https://example/256271.png',
      AdditionalDetails: d({ webbrandname: '4 Pines', webtitle: 'Pale Ale Can 375mL', webproducttype: 'Beer', webliquorsize: '375ML' }),
      Prices: {
        promoprice: { Message: 'case (18)', Value: 55, BeforePromotion: 67.99, IsMemberOffer: false },
        caseprice: { Message: 'case (18)', Value: 67.99 },
        singleprice: { Message: 'pack (6)', Value: 24.99 },
        inanysixprice: { Message: 'each (in-store)', Value: 5.49 },
      },
    }],
  };
  assert.deepEqual(dm.mapBundle(bundle, 'Beer').map(short), [
    '4 Pines Pale Ale Can 375mL Case | 18 x 375mL | 55 was 67.99',
    '4 Pines Pale Ale Can 375mL Pack | 6 x 375mL | 24.99',
    '4 Pines Pale Ale Can 375mL | 375mL | 5.49',
  ]);
  const [caseOf] = dm.mapBundle(bundle, 'Beer');
  assert.equal(caseOf.store_product_id, '256271-case');
  assert.equal(caseOf.on_special, true);
  assert.equal(caseOf.product_url, 'https://www.danmurphys.com.au/product/DM_256271/4-pines-pale-ale-can-375ml');
});

test('Dan Murphy’s: a wine bottle with an "any six" price is a multi-buy; member offers aren’t the price', () => {
  const bundle = {
    Products: [{
      Stockcode: '906100', PackageSize: '750ML',
      AdditionalDetails: d({ webbrandname: 'Yalumba', webtitle: 'Yalumba Y Series Shiraz 750mL', webproducttype: 'Red Wine' }),
      Prices: {
        promoprice: { Message: 'Each', Value: 10, BeforePromotion: 12.99, IsMemberOffer: true },
        singleprice: { Message: 'Each', Value: 12.99 },
        inanysixprice: { Message: 'in any six', Value: 11.5 },
        caseprice: { Message: 'case (6)', Value: 69 },
      },
    }],
  };
  const out = dm.mapBundle(bundle, 'Red Wine');
  assert.deepEqual(out.map(short), ['Yalumba Y Series Shiraz 750mL Case | 6 x 750mL | 69', 'Yalumba Y Series Shiraz 750mL | 750mL | 12.99 | 6 for 69']);
  assert.equal(out[1].member_price, 10);
  assert.equal(out[1].on_special, false);
});

test('BWS: one record per pack, counted from its unit quantity, the size borrowed from its bundle when missing', () => {
  const rec = (Stockcode, Price, WasPrice, count, type, size) => ({
    Stockcode, Price, WasPrice, BrandName: '4 Pines', PackageSize: size || '', UrlFriendlyName: '4-pines-american-amber-ale', IsAvailable: true,
    AdditionalDetails: d({ producttitle: 'American Amber Ale', webpacktype: type, productunitquantity: String(count), ...(size ? { liquorsize: size } : {}) }),
  });
  const out = bws.mapBundle({ Products: [rec(983411, 73, 73, 24, 'Case'), rec(983412, 22, 28, 6, 'Pack', '6 x 330mL'), rec(518180, 5.1, 5.1, 1, 'Bottle', '330mL')] }, 'Beer');
  assert.deepEqual(out.map(short), [
    '4 Pines American Amber Ale Case | 24 x 330mL | 73',
    '4 Pines American Amber Ale Pack | 6 x 330mL | 22 was 28',
    '4 Pines American Amber Ale | 330mL | 5.1',
  ]);
  assert.equal(out[0].product_url, 'https://bws.com.au/product/983411/4-pines-american-amber-ale');
});

test('Liquorland: each listing is one way of buying; "across any six" is a multi-buy on a bottle', () => {
  const base = { brand: 'Carlton', isAvailable: true, promotion: { calloutText: null }, image: { heroImage: '/-/media/x.ashx' } };
  const caseOf = ll.mapProduct({ ...base, id: '473583', name: 'Carlton Dry Bottle 330mL', volumeMl: 330, unitOfMeasure: 'CTN24', productUrl: '/beer/carlton-dry_473583', price: { current: 49, normal: 62, acrossAnySix: 0, memberOnlyPrice: 0 } }, 'Beer & Cider');
  assert.equal(short(caseOf), 'Carlton Dry Bottle 330mL Case | 24 x 330mL | 49 was 62');
  assert.equal(caseOf.product_url, 'https://www.liquorland.com.au/beer/carlton-dry_473583');
  const tenPack = ll.mapProduct({ ...base, id: '3026033', name: 'Mr Finch Apple Cider Can 375mL 10pk', volumeMl: 375, unitOfMeasure: 'PACK10', price: { current: 24, normal: 24 } }, 'Beer & Cider');
  assert.equal(short(tenPack), 'Mr Finch Apple Cider Can 375mL 10pk | 10 x 375mL | 24', 'the name already says the pack');
  const wine = ll.mapProduct({ ...base, id: '37297', name: 'Veuve Clicquot Yellow Label Brut NV 750mL', volumeMl: 750, unitOfMeasure: 'ea', price: { current: 82, normal: 101, acrossAnySix: 73.8, memberOnlyPrice: 0 } }, 'Wine');
  assert.equal(short(wine), 'Veuve Clicquot Yellow Label Brut NV 750mL | 750mL | 82 was 101 | 6 for 442.8');
  const litre = ll.mapProduct({ ...base, id: '1', name: 'Gin 1L', volumeMl: 1000, unitOfMeasure: 'ea', price: { current: 60, normal: 60 } }, 'Spirits');
  assert.equal(litre.size_text, '1L');
});

test('Coles leaves out its Liquorland department, now that Liquorland is its own shop', async () => {
  const { SKIP } = await import('../src/scrapers/coles.js');
  assert.ok(SKIP.has('liquorland'));
});
