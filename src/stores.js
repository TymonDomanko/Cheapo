// Every supermarket the app knows about. Adding a chain = a scraper module in
// src/scrapers/ plus an entry here.

export const STORE_INFO = {
  woolworths: {
    name: 'Woolworths',
    url: 'https://www.woolworths.com.au',
    online: true,
    note: 'Online prices',
  },
  coles: {
    name: 'Coles',
    url: 'https://www.coles.com.au',
    online: true,
    note: 'Online prices',
  },
  aldi: {
    name: 'ALDI',
    url: 'https://www.aldi.com.au',
    online: false,
    note: 'In-store only — no online grocery ordering',
  },
  iga: {
    name: 'IGA',
    url: 'https://www.igashop.com.au',
    online: true,
    note: 'Each IGA sets its own prices — you choose your store',
  },
  harrisfarm: {
    name: 'Harris Farm',
    url: 'https://www.harrisfarm.com.au',
    online: true,
    note: 'Online prices (NSW, QLD, ACT)',
  },
  // Liquor shops: only shown to people who've turned on Show alcohol.
  danmurphys: {
    name: 'Dan Murphy’s',
    url: 'https://www.danmurphys.com.au',
    online: true,
    liquor: true,
    note: 'Online prices',
  },
  bws: {
    name: 'BWS',
    url: 'https://bws.com.au',
    online: true,
    liquor: true,
    note: 'Online prices',
  },
  liquorland: {
    name: 'Liquorland',
    url: 'https://www.liquorland.com.au',
    online: true,
    liquor: true,
    // Prices are per state (LIQUOR_STATE).
    get note() {
      return `Online prices (${String(process.env.LIQUOR_STATE || 'nsw').toUpperCase()})`;
    },
  },
};

export const STORES = Object.keys(STORE_INFO);
/** Liquor shops: hidden unless someone has turned on Show alcohol. */
export const LIQUOR_STORES = STORES.filter((s) => STORE_INFO[s].liquor);
/** The shops someone sees: liquor shops only with alcohol on. */
export const visibleStores = (alcohol) => (alcohol ? STORES : STORES.filter((s) => !STORE_INFO[s].liquor));

export function storeName(id) {
  return STORE_INFO[id]?.name || id;
}
