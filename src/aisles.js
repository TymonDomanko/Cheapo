// Sorts products into the same handful of product types at every shop, in the
// order you'd usually walk a supermarket, for the in-the-shop checklist. Each
// store names its categories differently (and some barely at all), so this
// looks at the store's category first and falls back to the product's name.

export const AISLES = [
  { key: 'produce', label: 'Fruit & veg' },
  { key: 'bakery', label: 'Bakery' },
  { key: 'deli', label: 'Deli' },
  { key: 'meat', label: 'Meat & seafood' },
  { key: 'dairy', label: 'Dairy, eggs & fridge' },
  { key: 'pantry', label: 'Pantry' },
  { key: 'snacks', label: 'Snacks & sweets' },
  { key: 'drinks', label: 'Drinks' },
  { key: 'frozen', label: 'Frozen' },
  { key: 'health', label: 'Health & beauty' },
  { key: 'baby', label: 'Baby' },
  { key: 'pet', label: 'Pet' },
  { key: 'household', label: 'Household & cleaning' },
  { key: 'liquor', label: 'Liquor' },
  { key: 'other', label: 'Other' },
];

const ORDER = Object.fromEntries(AISLES.map((a, i) => [a.key, i]));
const LABEL = Object.fromEntries(AISLES.map((a) => [a.key, a.label]));

// Checked in this order, so the more specific types come first (frozen peas are
// frozen, not veg; dog food is pet, not meat; tomato sauce is pantry, not veg).
const RULES = [
  ['frozen', /\bfrozen|\bfreezer\b(?! bags?)|ice ?creams?\b|gelato|ice blocks?|\bsorbet|pastry sheets?|^pizzas$|^streets$/],
  ['liquor', /\bliquor|\bbeers?\b|\bwines?\b|\bcider\b|spirits|vodka|whisk(e)?y|\bgin\b|\brum\b|bourbon|prosecco|champagne|sauvignon|shiraz|chardonnay|merlot|pinot|\blager\b|\bale\b|seltzer|^ros[eé]$|premix(ed)? drinks|^liqueurs?$|sparkling ros/],
  ['pet', /\bpets?\b|petneeds|\bdogs?\b|\bcats?\b|kitten|puppy|\bbird ?seed|cat litter|pedigree|whiskas|dine\b|schmackos/],
  ['baby', /\bbaby|\binfant|nappies|nappy|toddler|formula\b|wipes.*baby|huggies/],
  ['health', /health|beauty|personal care|toiletr|vitamin|supplement|medicin|pharmacy|first aid|shampoo|conditioner|deodorant|toothpaste|toothbrush|\bsoap\b|body wash|razor|sunscreen|sun ?care|after sun|skin ?care|cosmetic|panadol|nurofen|tampons?|\bpads\b|feminine|hygiene|cold,? flu|allerg|hair styling|hair care|hair accessories|fragrance|perfume|makeup|make-up|^nails$|^eyes$|^lips$|^complexion$|styling products|shaving|hair removal|shower|\bbath\b|dental|continence|period care|band-?aids?|bandages|pain relief|cotton|lip balm|moisturis/],
  ['household', /household|cleaning|laundry|detergent|dishwash|toilet (paper|tissue|roll)|paper towel|tissues?\b|garbage|bin liners?|\bfoil\b|cling|baking paper|sponges?|bleach|disinfect|air freshener|batter(y|ies)|light ?bulbs?|kitchenware|zip ?lock|freezer bags?|napkins|insect|pest|stationery|gardening|lawn care|garden and lawn|food storage|bbq needs|home improvement|repair|clothing|apparel|\bcleaners?\b|hardware|candles|party supplies|lighting|torches|homewares|utensils|^kitchen$|gloves|mops|buckets|brooms|stain removal|pre-wash|car care/],
  ['drinks', /\bdrinks?\b|beverage|soft ?drink|\bjuices?\b|\bcola\b|coke\b|pepsi|lemonade|mineral water|sparkling water|\bwater\b(?! crackers)|cordial|energy drink|sports drink|kombucha|iced tea|\bcoffee\b|\btea\b|tea bags|hot chocolate|milo/],
  ['bakery', /bakery|\bbreads?\b|\brolls?\b|baguette|sourdough|wraps?\b|tortillas?|pita|croissants?|muffins?|crumpets?|bagels?|buns?\b|donuts?|doughnuts?|scrolls?\b|loaf|brioche|english muffin|\bcakes?\b(?! mix)|sweet treats|pizza bases?/],
  ['deli', /\bdeli\b|ham\b|salami|prosciutto|antipast[oi]|olives|hummus|\bdips?\b|smallgoods|cabanossi|kabana|pastrami|chorizo|pate\b|shaved/],
  ['meat', /\bmeat|butcher|\bgame\b|seafood|poultry|chicken|\bbeef\b|\blamb\b|\bpork\b|mince\b|sausages?|\bsteaks?\b|bacon|\bfish\b|salmon|prawns?|\btuna steak|fillets?|drumsticks?|thigh|cutlets?|chops?\b|roast\b|turkey|\bveal\b|burgers? patties/],
  ['dairy', /dairy|\beggs?\b|\bfridge|chilled|\bmilk\b|cheese|yogh?urt|(?<!peanut )\bbutter\b|\bcream\b|margarine|custard|\bdips?\b|tofu|fresh pasta|ready meals?|ready to eat|\bmeals\b|desserts?\b|plant based|vegetarian|\bvegan\b|kefir/],
  ['snacks', /snack|confection|chocolate|lollies|\blolly|candy|chips\b|crisps|biscuits?|cookies?|crackers?|\bnuts?\b|popcorn|muesli bars?|\bbars?\b|pretzels|gum\b|mints?\b|corn chips|\bchip\b|\bcrisps?\b|tim ?tam|shapes\b/],
  ['pantry', /pantry|breakfast|cereal|oats\b|porridge|muesli|baking|flour|sugar|\brice\b|pasta|noodles|sauces?\b|condiment|\bspreads?\b|peanut butter|vegemite|\bjam\b|honey|\boil\b|vinegar|spices?|seasoning|\bsalt\b|pepper\b|\bstock\b|canned|\btinned|\bcans?\b|soups?\b|\bbeans\b|lentils|chickpeas|\btuna\b|international|asian|mexican|indian|tomato paste|passata|curry|gravy|mayonnaise|mustard|ketchup|cake mix|yeast|cocoa|coconut milk|long ?life milk|uht|gluten free|italian|chutney|relish|sweeteners?|^cooking$|breadcrumbs|stuffing|meal kits|dry goods|\boils\b|quinoa|halal/],
  ['produce', /fruit|vegetable|\bveg\b|\bproduce\b|salad|herbs?\b|banana|apples?\b|oranges?\b|mandarins?|lemons?\b|limes?\b|berries|strawberr|blueberr|grapes?\b|avocado|tomato(es)?\b|potato(es)?\b|onions?\b|carrots?\b|broccoli|lettuce|spinach|cucumber|capsicum|zucchini|mushrooms?\b|pumpkin|garlic|ginger|celery|cabbage|cauliflower|kiwi|pears?\b|mango|melon|pineapple|sweet potato|corn cob|beans? (green|fresh)|asparagus|kale|leek|coleslaw|fresh flowers/],
];

/** Which aisle a product belongs in. @param {{name?:string, category?:string}} p */
export function aisleFor(p) {
  const category = String(p?.category || '').toLowerCase();
  const name = String(p?.name || '').toLowerCase();
  // Anything frozen is in the freezers, whatever the shop files it under.
  if (RULES[0][1].test(category) || RULES[0][1].test(name)) return 'frozen';
  for (const text of [category, name]) {
    if (!text) continue;
    for (const [key, re] of RULES) if (re.test(text)) return key;
  }
  return 'other';
}

/**
 * Is it alcohol? Going by the shop's own category (each shop files its liquor
 * separately), not the name: "ginger beer" and "wine vinegar" are groceries.
 */
export const isAlcohol = (p) => !!p?.category && aisleFor({ category: p.category }) === 'liquor';

export const aisleLabel = (key) => LABEL[key] || LABEL.other;
export const aisleOrder = (key) => ORDER[key] ?? ORDER.other;
