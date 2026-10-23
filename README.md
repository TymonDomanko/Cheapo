# Supermarket Tools

A self-hosted grocery price comparison site for **Woolworths, Coles and ALDI** (Australia).

- **Pulls every product and price** from all three stores (about 50,000 products) and refreshes them daily.
- **Search and compare.** Each result row shows the cheapest equivalent at each store. Products count as equivalent when they have **exactly the same pack size** (weight, volume or count) and a similar name, ignoring brand. So "Coles Full Cream Milk 3L", "Woolworths Full Cream Milk 3L" and "Farmdale Full Cream Milk 3L" are treated as the same item.
- **Shopping list.** Add products, set quantities, and pick how strict matching should be: any brand, same brand only, or this exact product. You can also override the product used at any store, or exclude a store for an item.
- **Order the cheapest.** One button splits your list so each item comes from the store where it's cheapest. It then opens a browser and fills your **Woolworths and Coles trolleys** with those items. ALDI Australia has no online grocery ordering, so ALDI items become a printable in-store list. It shows what the split saves compared with buying everything at one store.
- **Price history.** Every refresh records price changes. Each product has a step chart of its price over time, alongside the matching products at the other stores. A "Price changes" tab lists the biggest recent rises and drops.

## Quick start

```bash
npm install
npx playwright install chromium   # only needed for "Order cheapest" and SCRAPE_MODE=browser
npm run seed:demo                 # optional: fake demo data so you can try the UI immediately
npm start                         # http://localhost:3000
```

Then open the **Data** tab and press **Refresh prices now**, or run a scrape from the terminal:

```bash
npm run scrape                          # all stores, all categories (20–40 min)
npm run scrape -- coles                 # one store
npm run scrape -- aldi --max-pages=2    # quick partial run for testing
npm run scrape -- woolworths --categories=dairy-eggs-fridge,pantry
```

Once you have real data, remove the demo products with `npm run seed:demo -- --clear`.

The server refreshes prices automatically every day at 04:15 (`SCRAPE_CRON`). Price history builds up from your first scrape onwards, because the stores don't publish historical prices.

## How ordering works

1. Build your list and press **Order cheapest**. You'll see the split by store, with totals.
2. Press **Fill my trolleys**. A Chromium window opens with its own profile, saved in `data/browser-profile`, so you only need to log in once.
3. For Woolworths, items go in through the same trolley endpoint the website's own "Add to cart" button calls. For Coles, the app opens each product page and clicks **Add**. If an item can't be added (out of stock, or the store wants a delivery address first), it's listed with a link so you can add it yourself.
4. The browser stops at each trolley. **You choose a delivery or pick-up slot and pay yourself.** The app never completes a purchase.

## Configuration

Set these as environment variables (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `SCRAPE_CRON` | `15 4 * * *` | When to refresh prices automatically. Set it empty to disable. |
| `SCRAPE_MODE` | `fetch` | `browser` sends all scraping through a real Chromium, for when a store blocks plain HTTP requests |
| `DATA_DIR` / `DB_PATH` | `data/` | Where the SQLite database and browser profile live |
| `COLES_DELAY_MS`, `WOOLWORTHS_DELAY_MS`, `ALDI_DELAY_MS` | 1000 / 600 / 500 | Pause between requests to each store |
| `COLES_SKIP_CATEGORIES`, `WOOLWORTHS_SKIP_CATEGORIES`, `ALDI_SKIP_CATEGORIES` | seasonal / duplicate groups | Comma-separated category slugs to leave out |
| `CHROMIUM_PATH` | Playwright's | Use a different Chromium or Chrome binary |

## How it works

```
src/
  scrapers/        one module per store + shared HTTP client (cookies, retries, bot-check back-off)
    coles.js       Next.js JSON data routes  (/_next/data/<build>/en/browse/<category>.json)
    woolworths.js  /apis/ui/PiesCategoriesWithSpecials + /apis/ui/browse/category
    aldi.js        api.aldi.com.au /v2/product-category-tree + /v3/product-search
  units.js         pack-size parsing ("6 x 375mL" → 2250 ml, "Per Kg" → 1000 g)
  matcher.js       "is this the same product?" — same size + similar name, brand stripped
  compare.js       search, cross-store grouping, shopping list resolution, order plan
  order/           trolley-filling automation (Playwright)
  db.js            SQLite schema (products, price_history, shopping_list, …) with FTS5 search
  server.js        Express API + daily schedule
public/            the web UI (vanilla JS + Chart.js)
test/              unit tests for size parsing and matching (npm test)
```

### Matching rules

- Sizes are normalised to grams, millilitres or a count, and must match within 1%.
- Names are compared once brand names, store names ("Coles", "Woolworths", "Essentials"…), sizes and filler words are removed. A Dice similarity of at least 0.75 counts as a match.
- **Variant words** have to appear on both sides. "Lactose free", "light", "organic", "unsalted", "sliced" or "grated", and flavours such as "salt & vinegar" stop two products from matching even when the rest of the name is the same.
- If a match is still wrong, change it on the shopping list. Pick a specific product for that store, or switch the item to "Same brand only" or "This exact product".

## Caveats

- **Unofficial data.** None of these stores has a public API. The scrapers read the same JSON the store websites load, so a site redesign can break them. Each store's code is a short, self-contained module that's easy to fix.
- **Bot protection.** Woolworths and ALDI sit behind Akamai and can block datacentre or cloud IPs. Run the app from a home connection, or try `SCRAPE_MODE=browser`.
- **Prices are online prices.** In-store prices can differ by location. Coles and Woolworths prices here use their default store or region.
- **Use it for yourself.** Keep the request delays polite, and check each store's terms of use. This is a personal tool, not a service to run at scale.
