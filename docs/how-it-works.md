# How it works

## Where the prices come from

None of the supermarkets has a public API. Each scraper reads the same data the shop's own website loads.

| Chain | Source | Notes |
|---|---|---|
| Woolworths | Website JSON API | Can block cloud servers; a home connection or a helper works |
| Coles | Next.js data routes | Blocks connections that ask for too much (a "Pardon Our Interruption" bot check), so it's refreshed steadily rather than all at once (below) |
| ALDI | api.aldi.com.au | In-store only, so there's no online ordering |
| IGA | igashop.com.au storefront API | Each IGA has its own prices; only stores someone has picked are collected |
| Harris Farm | Shopify `/products.json` | NSW, QLD and ACT |
| Dan Murphy's, BWS | Endeavour Group's website API (`src/scrapers/endeavour.js`) | Liquor; shown only with **Show alcohol** on. Each way of buying (bottle, pack, case) is its own product, sized "24 x 375mL". Beer, wine, spirits, cider and premixes (Dan Murphy's premixes come from a product group, not a department) |
| Liquorland | Coles' liquor website API (`src/scrapers/coles-liquor.js`) | Liquor, as above; prices per state (`LIQUOR_STATE`). First Choice and Vintage Cellars now redirect to Liquorland, so it covers them. Coles' own Liquorland department is left out so nothing's listed twice |

Every night (`SCRAPE_CRON`) the server:
1. checks which IGAs publish prices online;
2. refreshes IGA, and starts Woolworths, ALDI and Harris Farm as shared refreshes. `src/sharing.js` splits each into parts (departments, or blocks of pages for Harris Farm), and the server and collectors each take a part at a time. A shop has no more parts on the go than one connection would fetch at once, and the last part in finishes the refresh. A part a connection goes quiet on is handed on, and one that failed isn't given back to the same connection;
3. fills in some Coles barcodes;
4. sends price alerts.

Products a complete crawl didn't see are marked unavailable. Each price change is kept in `price_history`, which drives the charts, the "is this a good price?" hints and the unusual-deal finder.

## Coles, a little at a time

Coles' bot protection blocks bursts, home connections included, so instead of crawling all ~520 pages each night the server asks for **one page every couple of minutes** (`COLES_PAGES_PER_HOUR`, default 30), all day, most important first:

1. **Searches.** When someone searches and the Coles results are more than a day old, Coles' own search for those words is fetched straight away (one page refreshes up to 48 products). The page asks again a few seconds later and shows today's prices.
2. **What people buy.** Once a day, Coles products on lists and watches that are over ~20 hours old.
3. **Specials.** Every product on special (about 150 pages), daily, since that's where prices move.
4. **The whole shop**, every `COLES_FULL_EVERY_DAYS` (2), carrying on where it left off. Products only become unavailable once a whole pass has missed them, and a finished pass counts as a refresh on the admin page (and in the "far fewer products" check).
5. **Barcodes** with whatever time is left.

Coles has about 30,000 products on about 640 pages. At the default 30 pages an hour (720 a day), the whole shop takes about two days, with specials every day. For **every price within a day**, set `COLES_FULL_EVERY_DAYS=1` and `COLES_PAGES_PER_HOUR=40`: a pass then starts every 24 hours and takes about 16 of them, and the separate specials run is skipped because the pass covers them. More requests an hour means a greater chance of a bot check.

A bot check pauses it for 2 hours, then 4, 8… up to a day, and admins get one email about it. The admin page's Coles tile shows what it's doing. `src/coles-live.js` has all of this.

**Sharing it.** Helpers can take part. Each connection takes a department, or the specials, and fetches its pages with the same code (`src/scrapers/coles-pages.js`). The page limit is for all of them together and is split evenly between the connections at work, except that none goes over its own cap (`COLES_MAX_PER_CONNECTION`, 40, or lower for a helper). What a capped connection can't use is shared among the others. Every answer tells a collector when to come back. Only connections that are part-way through something and on time are counted, so one that misses its turn by 3 minutes stops slowing the rest, and its department is handed on. A late answer for a page that has since been handed on is ignored. A bot check pauses only that connection. Searches, list items and barcodes stay on the server.

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
  coles-live.js    Coles a page at a time, shared between this server and collectors
  sharing.js       other shops' refreshes, split into parts and shared out
  helpers.js       approved helpers, their tokens and invite links
  helper-invite.js the invite page and email
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
deploy/            Docker Compose files for a server with a domain, and for a helper's collector
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
