# Supermarket Tools

A grocery price comparison site for Australian supermarkets: **Woolworths, Coles, ALDI, IGA and Harris Farm**. It can run publicly with accounts and shared household lists, or just on your own computer.

- **Every product and price** from each chain (about 60,000 products), refreshed daily.
- **Search and compare.** Each result shows the cheapest equivalent at every store. Products count as equivalent when they have **exactly the same pack size** (weight, volume or count) and a similar name, ignoring brand.
- **Accounts and shared lists.** Anyone can search. Signing up gives you a shopping list; you can make more lists and **share one with your household** using an invite link. Everyone on a shared list can add, change and remove items, and sees each other's changes.
- **Choose your shops.** Each list has a card per supermarket that you can tick or untick:
  - A shop you use says what it's **saving you** (how much more the list would cost without it), and warns if it's the only place you can get some items.
  - A shop you've excluded says what it's **costing you** (how much including it would save).
- **Order the cheapest.** Splits your list so each item comes from its cheapest shop. You get a per-shop list with product links, plus copy and print buttons. Totals are compared with buying everything at one shop.
- **Price history.** Each product has a step chart of its price over time, alongside the matching products at the other shops. A "Price changes" tab lists the biggest recent rises and drops.
- **Admin page.** Only admins can trigger a price refresh, see scrape status and errors, and manage who else is an admin. The public site has no refresh button.

## Run it on your computer

```bash
npm install
npm run seed:demo            # optional: fake demo data so you can try the UI immediately
ADMIN_EMAILS=you@example.com npm start   # http://localhost:3000, then sign up with that email
```

Open **Admin**, then press **Refresh all prices**. You can also scrape from the terminal:

```bash
npm run scrape                          # all stores (20–60 min)
npm run scrape -- iga harrisfarm        # some stores
npm run scrape -- aldi --max-pages=2    # quick partial run
```

Once you have real data, remove the demo products with `npm run seed:demo -- --clear`. You can make an existing account an admin with `npm run admin -- you@example.com`.

## Host it publicly

The repo includes a `Dockerfile` and `docker-compose.yml`. The database is one SQLite file on a persistent volume (`/data`).

```bash
cp .env.example .env     # set ADMIN_EMAILS and check the other settings
docker compose up -d --build
```

Put it behind a reverse proxy that handles HTTPS (Caddy, nginx, or your host's load balancer). In production, session cookies are HTTPS-only. Set `TRUST_PROXY` to the number of proxies in front of the app so client IPs (used for rate limiting) come through correctly. Sign up with the email in `ADMIN_EMAILS` to become the first admin.

Any host that can run a Docker container with a persistent disk will work (a VPS, Fly.io, Railway, Render with a disk, and so on). Run **one** instance: SQLite and the in-process rate limiter and scheduler assume a single server. For more than one instance, move to PostgreSQL.

**Scraping from a cloud server.** Coles, IGA and Harris Farm work from datacentre IPs. Woolworths and ALDI use Akamai bot protection that sometimes blocks cloud IPs. If their scrapes fail in the Admin page, run `npm run scrape -- woolworths aldi` from a home machine against the same database, or give the server a residential proxy through `HTTPS_PROXY`.

### Security

- Passwords are hashed with scrypt.
- Sessions are random tokens in HttpOnly, SameSite=Lax cookies; only a hash of each token is stored.
- State-changing requests must come from the site's own origin and be JSON.
- Login, sign-up and search are rate-limited.
- Every list endpoint checks membership: outsiders get "not found".
- Pages send a strict Content-Security-Policy.

## Ordering

On the public site, **Order cheapest** gives a per-shop list with links to each product and copy and print buttons. It doesn't buy anything. The shops have no public ordering APIs, and they can't be given your login.

When **self-hosting on your own computer**, set `ENABLE_TROLLEY_FILL=true` and run `npx playwright install chromium`. Admins then get a **Fill my trolleys automatically** button. It opens a browser on that machine, where you log in once, and adds the items to your Woolworths and Coles trolleys. It stops at the trolley, so you choose a delivery slot and pay yourself. Keep this off on a public server.

## Configuration

See `.env.example`. The main settings:

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_EMAILS` | — | Accounts with these emails become admins when they sign up |
| `ALLOW_SIGNUPS` | `true` | Set to `false` to close registration |
| `NODE_ENV` | — | `production` turns on HTTPS-only cookies |
| `TRUST_PROXY` | — | Number of reverse proxies in front of the app |
| `SCRAPE_CRON` | `15 4 * * *` | When to refresh prices (server time); empty disables it |
| `IGA_STORE_ID` | `32600` | Which IGA store's prices to track. IGA stores set their own prices; find IDs at `igashop.com.au/api/storefront/stores` |
| `SCRAPE_MODE` | `fetch` | `browser` scrapes through a real Chromium (needs Playwright) |
| `ENABLE_TROLLEY_FILL` | `false` | Self-hosted trolley automation (see above) |
| `DATA_DIR` / `DB_PATH` | `data/` | Where the SQLite database lives |
| `*_DELAY_MS`, `*_SKIP_CATEGORIES` | per store | Request pacing and categories to skip, per store |

## Supermarkets

| Chain | Source | Notes |
|---|---|---|
| Woolworths | Website JSON API | Akamai-protected; may need a home IP |
| Coles | Next.js data routes | Backs off automatically when it serves a bot check |
| ALDI | api.aldi.com.au | In-store only, so no online ordering |
| IGA | igashop.com.au storefront API | Prices for one IGA store (`IGA_STORE_ID`) |
| Harris Farm | Shopify `/products.json` | NSW, QLD and ACT |

Chains I looked at but didn't add:

- **Drakes** and **Foodland (SA)** both have online shops, but I couldn't reach either site from the development environment, so I couldn't check what their data looks like. They're good candidates to add next.
- **FoodWorks, Costco and Spudshed** don't publish a usable online grocery catalogue.

To add a chain, write a scraper module in `src/scrapers/` that yields products, then register it in `src/scrapers/index.js` and `src/stores.js`.

## How it works

```
src/
  scrapers/        one module per chain + shared HTTP client (cookies, retries, bot-check back-off)
  stores.js        the list of chains and their display info
  units.js         pack-size parsing ("6 x 375mL" → 2250 ml, "Per Kg" → 1000 g)
  matcher.js       "is this the same product?" — same size + similar name, brand stripped
  compare.js       search and cross-store grouping
  lists.js         shared lists, invites, per-store choices, cheapest split, store savings/cost
  auth.js          accounts, sessions, CSRF/origin checks, rate limiting
  order/           optional trolley-filling automation (Playwright, self-hosted only)
  db.js            SQLite schema (products, price_history, users, lists, …) with FTS5 search
  app.js           Express routes (public / logged-in / admin)
  server.js        starts the app + daily schedule
public/            the web UI (vanilla JS + Chart.js)
test/              unit tests for size parsing and matching, API tests for accounts, sharing and pricing (npm test)
```

### Matching rules

- Sizes are normalised to grams, millilitres or a count, and must match within 1%.
- Names are compared once brand names, store names ("Coles", "Woolworths", "Essentials"…), sizes and filler words are removed. A Dice similarity of at least 0.75 counts as a match.
- **Variant words** have to appear on both sides. "Lactose free", "light", "organic", "unsalted", "sliced" or "grated", and flavours such as "salt & vinegar" stop two products from matching even when the rest of the name is the same.
- If a match is still wrong, change it on the shopping list. Pick a specific product for that store, or switch the item to "Same brand only" or "This exact product".

## Caveats

- **Unofficial data.** None of these stores has a public API. The scrapers read the same JSON the store websites load, so a site redesign can break them. Each store's code is a short, self-contained module that's easy to fix.
- **Bot protection.** Woolworths and ALDI sit behind Akamai and can block datacentre or cloud IPs. Run the app from a home connection, or try `SCRAPE_MODE=browser`.
- **Prices are online prices.** In-store prices can differ by location. Coles and Woolworths use their default store or region, and IGA uses the one store you configure.
- **Terms of use.** Keep the request delays polite, and check each store's terms of use before running this publicly. Scraping data and republishing it is a grey area, and the stores may object to a public site.
