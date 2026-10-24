// Liquorland (Coles' liquor platform, see coles-liquor.js).
import { colesLiquor } from './coles-liquor.js';

const shop = colesLiquor({ store: 'liquorland', site: 'll', origin: 'https://www.liquorland.com.au' });

export const { store, departments, scrape, mapProduct } = shop;
