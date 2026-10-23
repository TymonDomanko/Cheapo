// Every supermarket the app knows about. Adding a chain = a scraper module in
// src/scrapers/ plus an entry here.

const IGA_STORE_ID = process.env.IGA_STORE_ID || '32600';

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
    note: `IGA stores set their own prices; these are from IGA store #${IGA_STORE_ID}`,
  },
  harrisfarm: {
    name: 'Harris Farm',
    url: 'https://www.harrisfarm.com.au',
    online: true,
    note: 'Online prices (NSW, QLD, ACT)',
  },
};

export const STORES = Object.keys(STORE_INFO);

export function storeName(id) {
  return STORE_INFO[id]?.name || id;
}
