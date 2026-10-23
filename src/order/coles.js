// Adds items to the Coles trolley by clicking "Add" on each product page.
// Coles may first ask you to choose delivery/click & collect — if so, do it in
// the opened window and re-run the order; the trolley keeps what was added.

import { addViaProductPage } from './ui.js';

const ORIGIN = 'https://www.coles.com.au';

export async function fillTrolley(page, items, log) {
  const added = [];
  const failed = [];
  for (const { product, quantity } of items) {
    if (await addViaProductPage(page, product.product_url, quantity)) {
      added.push(product.name);
      log(`added ${quantity} × ${product.name}`);
    } else {
      failed.push({ name: product.name, url: product.product_url, quantity });
      log(`could not add ${product.name} — add it manually: ${product.product_url}`);
    }
  }
  await page.goto(ORIGIN + '/checkout/trolley', { waitUntil: 'domcontentloaded' }).catch(() => {});
  return { added, failed };
}
