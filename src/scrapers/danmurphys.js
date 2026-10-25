// Dan Murphy's (Endeavour Group's platform, see endeavour.js).
import { endeavour } from './endeavour.js';

const shop = endeavour({
  store: 'danmurphys',
  origin: 'https://www.danmurphys.com.au',
  api: 'https://api.danmurphys.com.au/apis/ui',
  method: 'POST',
  // Its bot protection refuses (HTTP 403) requests made by Node's own HTTP
  // client, whatever the headers, but answers the same request from curl
  // (checked from a home connection). No cookies either: it needs none.
  cookies: false,
  curl: true,
  departments: [
    ['beer', 'Beer', 'beer'],
    ['red-wine', 'Red Wine', 'red wine'],
    ['white-wine', 'White Wine', 'white wine'],
    ['champagne-sparkling', 'Champagne & Sparkling', 'champagne sparkling'],
    ['spirits', 'Spirits', 'spirits'],
    ['cider', 'Cider', 'cider'],
    ['fortified-wine', 'Fortified Wine', 'fortified wine'],
  ].map(([key, name, department]) => ({ key, name, department }))
    // Premixes aren't a department, only a product group.
    .concat([{ key: 'premix', name: 'Premix Drinks', group: 'premix' }]),
  productUrl: (p) => `https://www.danmurphys.com.au/product/DM_${p.Stockcode}/${p.UrlFriendlyName || ''}`,
});

export const { store, departments, scrape, mapBundle } = shop;
