// BWS (Endeavour Group's platform, see endeavour.js). Its departments only list
// everything under their "All …" sub-departments.
import { endeavour } from './endeavour.js';

const shop = endeavour({
  store: 'bws',
  origin: 'https://bws.com.au',
  api: 'https://api.bws.com.au/apis/ui',
  method: 'GET',
  departments: [
    ['beer', 'Beer', 'beer', 'all beer'],
    ['cider', 'Cider', 'beer', 'cider'],
    ['wine', 'Wine', 'wine', 'all wine'],
    ['spirits', 'Spirits', 'spirits', 'all spirits'],
  ].map(([key, name, department, subDepartment]) => ({ key, name, department, subDepartment })),
  productUrl: (p) => `https://bws.com.au/product/${p.Stockcode}/${p.UrlFriendlyName || ''}`,
});

export const { store, departments, scrape, mapBundle } = shop;
