# How it works

## Where the prices come from

None of the supermarkets has a public API. Each scraper reads the same data the shop's own website loads.

| Chain | Source | Notes |
|---|---|---|
| Woolworths | Website JSON API | Can block cloud servers; a home connection or the home collector works |
| Coles | Next.js data routes | Blocks connections that ask for too much (a "Pardon Our Interruption" bot check). The crawl stops, remembers where it was, and carries on a few hours later |
| ALDI | api.aldi.com.au | In-store only, so there's no online ordering |
| IGA | igashop.com.au storefront API | Each IGA has its own prices; only stores someone has picked are collected |
| Harris Farm | Shopify `/products.json` | NSW, QLD and ACT |

Every night (`SCRAPE_CRON`) the server:
1. checks which IGAs publish prices online;
2. refreshes every shop, except ones a home collector sends;
3. fills in some Coles barcodes;
4. sends price alerts.

Products a complete crawl didn't see are marked unavailable. Each price change is kept in `price_history`, which drives the charts, the "is this a good price?" hints and the unusual-deal finder.

## Matching the same product across shops

- **Sizes** are parsed into grams, millilitres or a count: "6 x 375mL" is 2250 ml, "Per Kg" is 1000 g per kg, and "Banana Each" is 1 item. They must match within 1%.
- **Names** are compared once brand names, shop names ("Coles", "Woolworths", "Essentials"…), sizes and filler words are removed. A Dice similarity of at least 0.75 counts as a match.
- **Variant words** must appear on both sides. "Lactose free", "light", "organic", "unsalted", "sliced", "dried", "frozen", flavours and so on stop two products matching, even when the rest of the name is the same.
- **Barcodes** match Woolworths and Coles products exactly, which catches products whose names differ.
- **Admins' fixes** from "Wrong match?" reports override all of the above.

## "The cheapest of it, any brand"

`src/bestprice.js` answers the panel at the top of a search:

1. Search with the words, without any size. Keep products with every word in their own name ("eggs" isn't matched by the category "Dairy, Eggs & Fridge").
2. Choose the shop section, counting products that *are* the thing searched for. "Bananas" counts; "Banana Bread" doesn't. A plain fruit or veg name means the fresh kind when there's a fair choice of it.
3. Keep plain versions only. Products with variant words you didn't ask for are offered as chips instead ("Lactose free", "Oat"…).
4. Group what's left:
   - **a size you asked for** (`milk 2l`): one ranking, plus the cheapest at each shop;
   - **no size** (`milk`): the most common sizes, with the best value per litre, kilo or item;
   - **fruit and veg:** by the kilo and each, cheapest per unit first.

**Add cheapest** list items store the search ("milk 2l") and re-run it whenever the list is priced.

## Code layout

```
src/
  scrapers/        one module per chain, plus the shared HTTP client (cookies, retries, bot-check back-off)
  stores.js        the chains and their display info
  units.js         pack-size parsing
  matcher.js       "is this the same product?"
  match-index.js   in-memory size and word indexes, so matching takes milliseconds
  compare.js       search and cross-shop grouping
  bestprice.js     "the cheapest of it, any brand"
  lists.js         lists, sharing, per-shop choices, the cheapest split, what each shop saves or costs
  deals.js         regulars on sale, unusual deals
  insights.js      "is this a good price?"
  auth.js          accounts, sessions, origin checks, rate limiting
  admin-alerts.js  the summary email after a refresh
  order/           optional trolley filling (Playwright, self-hosted only)
  db.js            SQLite schema and migrations, FTS5 search
  app.js           Express routes
  server.js        starts the app and the schedules
  cli/             scrape, collect, seed demo data, make an admin, build collector programs
public/            the web app (vanilla JS, Chart.js; works offline)
test/              npm test
deploy/            Docker Compose files for a server with a domain, and for the home collector
```

## Developing

```bash
npm install
npm run seed:demo                         # demo data
ADMIN_EMAILS=you@example.com npm run dev  # restarts on changes, http://localhost:3000
npm test
```

Scrape from the terminal:

```bash
npm run scrape                          # every shop (30–60 min)
npm run scrape -- iga harrisfarm        # some shops
npm run scrape -- aldi --max-pages=2    # a quick partial run
```

- `npm run seed:demo -- --clear` removes the demo products.
- `npm run admin -- you@example.com` makes an existing account an admin.

## Adding a supermarket

1. Write `src/scrapers/<chain>.js`. It needs an async generator, `scrape({ log })`, that yields batches of products shaped like this: `{ store_product_id, name, brand, size_text, category, price, was_price, image_url, product_url, available }`. Look at `harrisfarm.js` for a short example.
2. Register it in `src/scrapers/registry.js` and `src/stores.js`.
3. Run `npm run scrape -- <chain> --max-pages=2` and check the results on the site.

To see how a shop's website loads its products, run `npm run capture -- <shop>` on a home machine (after `npx playwright install chromium`). It opens the shop in a browser and saves every product-data response to `data/capture-*.json`. Drakes and Foodland are good candidates to add next. FoodWorks, Costco and Spudshed don't publish a usable online catalogue.
