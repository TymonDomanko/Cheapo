// Bread, sorted the way people shop for it: what it is (a loaf, rolls, buns,
// wraps…) and what it's made from (white, wholemeal, wholegrain…). Search
// uses it to answer "bread", "white bread" or "wholemeal rolls" with the
// cheapest of each kind, instead of grouping by pack size (src/bestprice.js).

// What it is. The first whose words are in the name wins, so "Hot Dog Rolls"
// are rolls and "Brioche Burger Buns" are buns, not loaves.
export const BREAD_TYPES = [
  { key: 'wrap', label: 'Wraps & flatbread', re: /\bwraps?\b|tortillas?|\bpitt?as?\b|lebanese|souvlaki|\bnaans?\b|flat ?breads?|mountain bread|\broti\b|lavash|pockets?\b|piadina|\bburrito|khobz|\bpide\b|fajitas?/ },
  { key: 'bagel', label: 'Bagels', re: /\bbagels?\b/ },
  { key: 'crumpet', label: 'Crumpets', re: /\bcrumpets?\b/ },
  { key: 'muffin', label: 'English muffins', re: /english (style )?muffins?|\bbreakfast muffins?/ },
  { key: 'bun', label: 'Buns', re: /\bbuns?\b|\bsliders?\b|hot cross/ },
  { key: 'roll', label: 'Rolls', re: /\brolls?\b|\bhot dogs?\b|\bsubs?\b|\bdinner rolls?|\bpanini\b|\bthins\b/ },
  { key: 'crusty', label: 'Baguettes & crusty loaves', re: /baguettes?|french sticks?|\bvienna\b|turkish|ciabatta|\bcob\b|pane di casa|\bbatard|focaccia|\bstick\b|\bboule\b/ },
  { key: 'loaf', label: 'Loaves', re: /\bbreads?\b|\bloaf\b|\bloaves\b|\btoast\b|toaster|sandwich|sourdough|\bsliced\b|\brye\b|\bblock\b|high top|\bwholemeal\b|\bmultigrain\b|\bbrioche\b|challah|soy (&|and )?lin/ },
];

// Not bread, though the words are there: cakes, crumbs, mixes, garlic bread, snacks.
const NOT_BREAD = /crumbs?\b|\bmix\b|premix|banana bread|zucchini bread|\bshortbread|gingerbread|\bcorn ?bread|pudding|stuffing|croutons?|breadsticks?|bread ?sticks?|bruschetta|\bpizza|crisps?\b|chips?\b|crackers?|crispbread|rusks?|\bsausage rolls?|spring rolls?|\bcakes?\b|\bslice\b|\btart|\bscrolls?\b|cinnamon roll|danish|croissant|donut|doughnut|custard|\bjam\b|choc|pikelets?|pancakes?|crepes?|waffles?|cookies?|meringue|sushi|toilet|paper|\bfoil\b|\bcling|bake ?paper|\byeast|\bflour\b(?! tortilla)|batter|egg rolls?|rice paper|\bham\b|chicken|beef|pork/;

/** What a bakery product is ('loaf', 'roll'…), or null if it isn't bread. */
// Garlic bread is a frozen or chilled side; garlic naan, roti and wraps are bread.
const GARLIC_BREAD = /garlic (bread|slices?|loaf|baguette|traditional|twin)|cheesy garlic|bread (cheesy )?garlic/;

export function breadType(name, category = '') {
  const n = String(name).toLowerCase();
  if (NOT_BREAD.test(n)) return null;
  const type = BREAD_TYPES.find((t) => t.re.test(n))?.key;
  if (type !== 'wrap' && GARLIC_BREAD.test(n)) return null;
  if (type) return type;
  // A name with no type word ("Burgen Soy Linseed", "Helga's Sweet Potato"): the shop's own aisle says.
  const c = String(category).toLowerCase();
  if (/wraps?\b|flat ?bread|tortilla/.test(c)) return 'wrap';
  if (/\bbreads?\b/.test(c) && !/\bmix|garlic|crumb|rolls|bagels|buns/.test(c)) return 'loaf';
  return null;
}

// What it's made from. The first that fits wins: gluten-free sourdough is
// gluten free, wholemeal sourdough is sourdough, and plain is white.
export const BREAD_GRAINS = [
  { key: 'glutenfree', label: 'Gluten free', search: 'gluten free', re: /gluten[ -]?free|\bgf\b|\bcoeliac/ },
  { key: 'fruit', label: 'Fruit', search: 'fruit', re: /\bfruit|raisin|sultana|cinnamon|hot cross|date\b|fig\b/ },
  { key: 'lowcarb', label: 'Low carb', search: 'low carb', re: /low(er)? carb|\bketo\b|high protein|\bprotein\b/ },
  { key: 'rye', label: 'Rye', search: 'rye', re: /\brye\b|pumpernickel/ },
  { key: 'sourdough', label: 'Sourdough', search: 'sourdough', re: /sour ?dough/ },
  { key: 'wholemeal', label: 'Wholemeal', search: 'wholemeal', re: /whole ?meal|whole ?wheat|\bspelt\b/ },
  { key: 'grain', label: 'Wholegrain & seeds', search: 'wholegrain', re: /whole ?grain|multi ?grain|\bgrains?\b|(?<!sesame |poppy )\bseeds?\b|(?<!sesame )seeded|linseed|\bsoy\b|\boats?\b|\bchia\b|\bquinoa\b|\bkibbled|\bbarley\b|\bancient\b|\bflax/ },
  { key: 'white', label: 'White', search: 'white', re: /./ },
];

/** What a bread is made from ('white', 'wholemeal'…). */
export function breadGrain(name) {
  const n = String(name).toLowerCase();
  return BREAD_GRAINS.find((g) => g.re.test(n)).key;
}

/** Words that ask for bread of a type: "rolls", "wraps", "bagel"… → its key. */
const TYPE_WORDS = {
  bread: null, breads: null, loaf: 'loaf', loaves: 'loaf', toast: 'loaf', sandwich: 'loaf',
  roll: 'roll', rolls: 'roll', bun: 'bun', buns: 'bun', wrap: 'wrap', wraps: 'wrap', tortilla: 'wrap', tortillas: 'wrap',
  pita: 'wrap', pitta: 'wrap', flatbread: 'wrap', flatbreads: 'wrap', naan: 'wrap', lebanese: 'wrap',
  bagel: 'bagel', bagels: 'bagel', crumpet: 'crumpet', crumpets: 'crumpet', baguette: 'crusty', baguettes: 'crusty', turkish: 'crusty',
};
/** Words that ask for a grain: "white", "wholemeal", "gluten free"… → its key. */
const GRAIN_WORDS = [
  [/gluten[ -]?free|\bgf\b/, 'glutenfree'], [/\bfruit\b|raisin/, 'fruit'], [/low[ -]?carb|\bketo\b|protein/, 'lowcarb'],
  [/\brye\b/, 'rye'], [/sour ?dough/, 'sourdough'], [/whole ?meal|whole ?wheat/, 'wholemeal'],
  [/whole ?grain|multi ?grain|\bgrains?\b|\bseed(s|ed)?\b/, 'grain'], [/\bwhite\b/, 'white'],
];

/**
 * Is this a search for bread? Returns what it asks for, { type, grain, rest }
 * (rest: any other words, like a brand), or null. "bread", "white bread",
 * "wholemeal rolls", "sourdough", "bagels".
 */
export function breadQuery(q) {
  let s = ` ${String(q).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
  let grain = null;
  for (const [re, key] of GRAIN_WORDS) {
    if (re.test(s)) {
      grain = key;
      s = s.replace(re, ' ');
      break;
    }
  }
  const words = s.split(/\s+/).filter(Boolean);
  const typeWords = words.filter((w) => w in TYPE_WORDS);
  // "bread" (or a type) has to be asked for, or a grain that only bread has ("sourdough", "wholemeal").
  if (!typeWords.length && !/english muffins?/.test(s) && !['sourdough', 'wholemeal', 'rye'].includes(grain)) return null;
  const type = /english muffins?/.test(s) ? 'muffin' : typeWords.map((w) => TYPE_WORDS[w]).find(Boolean) || null;
  // Anything else ("burger", "hot dog", a brand) has to be in the name.
  const rest = words.filter((w) => !(w in TYPE_WORDS) && !['english', 'muffin', 'muffins', 'free', 'and', 'the'].includes(w));
  return { type, grain, rest };
}

/** The order types are shown in: loaves first. */
export const TYPE_ORDER = ['loaf', 'roll', 'bun', 'wrap', 'crusty', 'bagel', 'muffin', 'crumpet'];

export const typeLabel = (key) => BREAD_TYPES.find((t) => t.key === key)?.label || key;
export const grainLabel = (key) => BREAD_GRAINS.find((g) => g.key === key)?.label || key;
/** The words a chip adds to a search to ask for this type. */
export const TYPE_SEARCH = { loaf: 'loaf', roll: 'rolls', bun: 'buns', wrap: 'wraps', bagel: 'bagels', crumpet: 'crumpets', muffin: 'english muffins', crusty: 'baguette' };
