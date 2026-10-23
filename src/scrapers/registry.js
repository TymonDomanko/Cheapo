// The store scrapers, without any server code — shared by the server and the
// home collector (which is packaged on its own; see src/collector-files.js).
import * as woolworths from './woolworths.js';
import * as coles from './coles.js';
import * as aldi from './aldi.js';
import * as iga from './iga.js';
import * as harrisfarm from './harrisfarm.js';

export const SCRAPERS = { woolworths, coles, aldi, iga, harrisfarm };
