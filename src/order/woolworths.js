// Adds items to the Woolworths trolley by calling the same endpoint the
// website's "Add to cart" button uses, from inside a real logged-in page.
// Falls back to clicking the button on the product page.

import { addViaProductPage } from './ui.js';

const ORIGIN = 'https://www.woolworths.com.au';

export async function fillTrolley(page, items, log) {
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const added = [];
  const failed = [];
  for (const it of items) {
    const { product, quantity } = it;
    const ok = await page.evaluate(async ({ stockcode, quantity }) => {
      try {
        const r = await fetch('/apis/ui/Trolley/Update', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            items: [{ stockcode: Number(stockcode), quantity, source: 'ProductDetail', diagnostics: '0',
              searchTerm: null, evaluateRewardPoints: false, offerId: null, profileId: null, priceLevel: null }],
          }),
        });
        return r.ok;
      } catch {
        return false;
      }
    }, { stockcode: product.store_product_id, quantity }).catch(() => false);

    if (ok || await addViaProductPage(page, product.product_url, quantity)) {
      added.push(product.name);
      log(`added ${quantity} × ${product.name}`);
    } else {
      failed.push({ name: product.name, url: product.product_url, quantity });
      log(`could not add ${product.name} — add it manually: ${product.product_url}`);
    }
  }
  await page.goto(ORIGIN + '/shop/cart', { waitUntil: 'domcontentloaded' }).catch(() => {});
  return { added, failed };
}
