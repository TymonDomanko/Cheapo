// Generic "open product page, press Add, bump the quantity" automation shared
// by the store adapters. Uses accessible names rather than CSS classes so it
// survives most site redesigns.

const ADD_RE = /^(add( to (cart|trolley))?|add\b.*to (cart|trolley))$/i;
const MORE_RE = /(increase|add one more|plus|\+|increment)/i;

export async function addViaProductPage(page, url, quantity) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const add = page.getByRole('button', { name: ADD_RE }).first();
    await add.waitFor({ state: 'visible', timeout: 15000 });
    await add.click();
    for (let i = 1; i < quantity; i++) {
      const more = page.getByRole('button', { name: MORE_RE }).first();
      await more.waitFor({ state: 'visible', timeout: 8000 });
      await more.click();
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(800);
    return true;
  } catch {
    return false;
  }
}
