// Pickles, sorted by what they are. "Pickles" means several different jars:
// sweet mustard pickles (a relish), Branston (a chutney), dill pickles and
// gherkins (cucumbers), pickled onions… Search uses this to answer "pickles"
// with the cheapest of each kind rather than by jar size (src/bestprice.js).

// The first that fits wins.
export const PICKLE_TYPES = [
  { key: 'mustard', label: 'Sweet mustard pickles', search: 'mustard pickles', re: /mustard pickles?|pickles?( sweet)? mustard(?! seed)|sandwich pickles?|pickles? sandwich|sweet pickles?\b|piccalilli|mustard relish|\bchow ?chow/ },
  { key: 'branston', label: 'Branston & ploughman’s', search: 'branston', re: /branston|ploughman/ },
  { key: 'indian', label: 'Indian pickles', search: 'indian pickle', re: /\b(mango|lime|lemon|chilli|mixed|garlic|brinjal|carrot) pickle\b|\bachaar?\b|\barth\b|priya|patak|\bmothers?\b|\bnilon/ },
  { key: 'onion', label: 'Pickled onions', search: 'pickled onions', re: /\bonions?\b|shallots?/ },
  { key: 'jalapeno', label: 'Jalapeños & chillies', search: 'pickled jalapenos', re: /jalape|chill?i(es)?\b|\bpeppers?\b|pepperoncini|banana peppers/ },
  { key: 'kraut', label: 'Sauerkraut & kimchi', search: 'sauerkraut', re: /sauerkraut|kimchi/ },
  { key: 'cucumber', label: 'Dill pickles & gherkins', search: 'gherkins', re: /gherkins?|cornichons?|\bdill\b|cucumbers?|burger pickles?|bread (&|and) butter|\bpickles?\b/ },
  { key: 'veg', label: 'Pickled vegetables', search: 'pickled vegetables', re: /giardiniera|beetroot|cauliflower|\bcarrots?\b|cabbage|sauerkraut|kimchi|radish|turnip|mixed vegetables|vegetables|\bginger\b|\bgarlic\b|capsicum|asparagus|okra|\bbeans?\b|walnuts?|eggs?\b|mustard greens|pickled mustard/ },
];

// Not a jar of pickles, though the word is there.
const NOT_PICKLES = /mayo(nnaise)?|aioli|\bdips?\b|\bsauce\b|relish|chutney|\bchips?\b|crisps|flavou?r|seasoning|\bsalt\b|juice|cheese|\bsnack|\bbites\b|popcorn|\bcrackers?|chocolate|lollies|\bspray|spice mix|pickling spice|\bkits?\b|\bsoup\b|ramen|noodles?|dumplings?|\bmandu\b|seaweed|\bcup\b|stir fry|burger\b(?! pickles?)|\bwraps?\b|\bham\b|\bpork\b|herring|\bmeat\b/;

/** What kind of pickle a product is, or null if it isn't one. Names that don't say "pickle" have to be a gherkin, cornichon or say "pickled". */
export function pickleType(name) {
  const n = String(name).toLowerCase().replace(/[’']/g, '');
  if (NOT_PICKLES.test(n)) return null;
  if (!/pickle|gherkin|cornichon|branston|piccalilli|achaa?r|sauerkraut|kimchi|giardiniera/.test(n)) return null;
  return PICKLE_TYPES.find((t) => t.re.test(n))?.key || null;
}

/**
 * Is this a search for pickles? Returns { type, rest } (rest: other words,
 * like "dill" or a brand, that have to be in the name), or null.
 * "pickles", "gherkins", "dill pickles", "pickled onions", "branston pickle".
 */
export function pickleQuery(q) {
  const s = ` ${String(q).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
  if (!/\bpickles?\b|\bpickled\b|gherkins?|cornichons?|piccalilli/.test(s)) return null;
  let type = null;
  if (/gherkins?|cornichons?|\bdill\b|burger pickles?|bread (and )?butter/.test(s)) type = 'cucumber';
  else if (/mustard|piccalilli|\bsweet pickles?\b/.test(s)) type = 'mustard';
  else if (/branston|ploughman/.test(s)) type = 'branston';
  else if (/\bonions?\b/.test(s)) type = 'onion';
  else if (/jalape|chill?i/.test(s)) type = 'jalapeno';
  else if (/\b(mango|lime|lemon|indian) pickles?\b/.test(s)) type = 'indian';
  const rest = s.split(/\s+/).filter((w) => w && !/^(pickles?|pickled|gherkins?|cornichons?|sweet|mustard|onions?|jalapenos?|and|in|the|branston|indian)$/.test(w));
  return { type, rest };
}

export const pickleLabel = (key) => PICKLE_TYPES.find((t) => t.key === key)?.label || key;
