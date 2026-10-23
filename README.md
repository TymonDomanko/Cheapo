# Supermarket Tools

A grocery price comparison site for Australian supermarkets: **Woolworths, Coles, ALDI, IGA and Harris Farm**. It can run publicly with accounts and shared household lists, or just on your own computer.

- **Every product and price** from each chain (about 60,000 products), refreshed daily.
- **Deals on the home page.** Your regulars (things you buy often or have on your lists) that are on special, a multi-buy or a member price at one of your shops, even if it's a different brand of the same thing. Plus **unusual deals**: specials that break a product's normal pattern, like its first special in months or cheaper than its specials usually get. The every-few-weeks half-price cycles aren't included.
- **Search and compare.** Each result shows the cheapest equivalent at every store. Products count as equivalent when they have **exactly the same pack size** (weight, volume or count) and a similar name, ignoring brand.
- **Sign-up, log-in and settings pages.** At `/signup` you pick the shops you use. At `/settings` you change those shops, your name and your password, or delete your account. Search only compares your shops, and new lists start with them.
- **Choose your IGA.** Every IGA sets its own prices, so people pick their store by suburb, postcode, or "Near me". You can do this from the compare page, at sign-up, in settings, or per shared list. Only IGAs that publish their prices online (on igashop.com.au) can be picked, and the picker says so. Which stores qualify is re-checked every day: IGA's store list is reloaded and each store is asked for a product, so stores that start publishing prices appear and ones that stop are hidden. The first time anyone picks a store, its prices are fetched in the background (about 2 minutes) and then refreshed daily.
- **Accounts and shared lists.** Anyone can search. Signing up gives you a shopping list; you can make more lists and **share one with your household** using an invite link. Everyone on a shared list can add, change and remove items, and sees each other's changes.
- **Choose your shops.** Each list has a card per supermarket that you can tick or untick:
  - A shop you use says what it's **saving you** (how much more the list would cost without it), and warns if it's the only place you can get some items.
  - A shop you've excluded says what it's **costing you** (how much including it would save).
- **Order the cheapest.** Splits your list so each item comes from its cheapest shop (or the shop you've pinned it to: "always buy this at Coles", with what that costs you). You get a per-shop list with product links, plus copy and print buttons. Totals are compared with buying everything at one shop.
- **Price history.** Each product has a step chart of its price over time, alongside the matching products at the other shops. A "Price changes" tab lists the biggest recent rises and drops.
- **Is this a good price?** Products and list items say when today's price is the lowest in months, or when something regularly goes on special ("about every 6 weeks, next one likely in ~2 weeks") so you can wait.
- **Barcode matching.** Woolworths and Coles products are matched exactly by barcode, which catches products whose names differ. Anyone can press **Wrong match?**; an admin confirms it and the fix applies for everyone.
- **Deals that change the maths.** Multi-buys ("5 for $9") and Everyday Rewards member prices are counted. Each shopper ticks their memberships in Settings, and list totals work out the real cost of the quantity you need.
- **Better-value sizes.** If the same item in another pack size is at least 10% cheaper per kg, litre or item, you see a hint ("3L is 18% cheaper per litre").
- **Alerts.** Watch any product for a target price or any drop. There's also a Wednesday email of what's on special from your lists.
- **Anything on the list.** Add products, or plain notes like "birthday card". **Paste a list** ("milk, bread, 2 x chips") and confirm what each line matches.
- **In the shop.** A checklist per shop, sorted by section in the order you walk the store. It learns your own shop's layout from the order you tick things off. Tap to cross items out, or **scan a barcode** to tick it (or to see what it costs elsewhere). Ticks sync to everyone on a shared list and work offline (the site can be installed as an app). **Finish shop** saves what you bought so you can repeat it, and you can save regular shops to add in one go.
- **Spending.** Each finished shop records what it cost and how much splitting it across shops saved, with a monthly chart.
- **Home collector, one click.** For stores that block cloud servers, the Admin page has download buttons for the home collector. Each download is already set up for your site.
  - On Windows and Linux (including a Raspberry Pi), it's a single program to run, with nothing to install.
  - On a Mac, it's a zip that runs with Node.js.
  - It updates itself, and the Admin page shows whether it's connected and current.
- **Accounts done properly.** Email confirmation, password reset, a privacy page, and data export and deletion in Settings.
- **Admin page.** Only admins can trigger a price refresh, see scrape status and errors, and manage who else is an admin. The public site has no refresh button. A **data health** panel shows how fresh and comparable each shop's data is.
- **Problems come to you.** Admins are emailed when a refresh fails or finds far fewer products than usual, when the home collector goes quiet, and again when things recover.

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

[DEPLOY.md](DEPLOY.md) has step-by-step guides for each way of running it:

- **Docker on your machine:** `cp .env.example .env && docker compose up -d`
- **Docker on a server with your domain:** the files in `deploy/docker/` add automatic HTTPS (Caddy) and nightly updates (Watchtower).
- **Cloud:** `fly.toml` for Fly.io (Sydney region) or `render.yaml` for a Render Blueprint.

A GitHub Action tests the app and publishes the image to `ghcr.io/tymondomanko/supermarket-tools` on every push to `main`.

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

See `.env.example`. Settings marked *Also on the Admin page* can be changed by an admin under **Site settings**. If they're also in `.env`, the `.env` value wins and the Admin page shows them locked. The main settings:

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_EMAILS` | — | Accounts with these emails become admins when they sign up |
| `ALLOW_SIGNUPS` | `true` | Set to `false` to close registration |
| `NODE_ENV` | — | `production` turns on HTTPS-only cookies |
| `TRUST_PROXY` | — | Number of reverse proxies in front of the app |
| `SECURE_COOKIES` | `true` in production | Set to `false` only when serving over plain http on a LAN |
| `TZ` | server's | Time zone for the refresh schedule, e.g. `Australia/Sydney` |
| `SCRAPE_CRON` | `15 4 * * *` | When to refresh prices (server time); empty disables it |
| `IGA_STORE_ID` | `32600` | Default IGA store for visitors who haven't picked one |
| `SMTP_URL`, `MAIL_FROM`, `SITE_URL` | — | Sending email (see DEPLOY.md). Without them, emails go to the admin outbox. *Also on the Admin page* |
| `CONTACT_EMAIL`, `SITE_OPERATOR` | — | Shown on the privacy page. *Also on the Admin page* |
| `COLLECTOR_TOKEN`, `SERVER_SCRAPE_STORES` | — | Accept prices from a home collector, and leave those stores out of the server's own crawl. *Also on the Admin page* |
| `LITESTREAM_*` | — | Continuous off-site backup (see DEPLOY.md) |
| `BACKUP_KEEP_DAYS` | `7` | Daily on-disk snapshots to keep |
| `COLES_BARCODE_BUDGET` | `1500` | Coles product pages fetched per day for barcodes |
| `IGA_MAX_STORES` | no limit | Optional cap on how many IGA stores' prices are collected. Each adds about 2 minutes to the daily refresh and about 2 MB of storage |
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
| IGA | igashop.com.au storefront API | Prices for each IGA store someone has picked |
| Harris Farm | Shopify `/products.json` | NSW, QLD and ACT |

Chains I looked at but didn't add:

To help add Drakes or Foodland, run `npm run capture -- drakes` (or `foodland`) on a home machine, after a one-time `npx playwright install chromium`. It opens their online shop in a browser and saves every product-data response to `data/capture-*.json`. That file is enough to write a scraper from.

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
- **Prices are online prices.** In-store prices can differ by location. Coles and Woolworths use their default store or region. IGA uses each person's chosen store.
- **Terms of use.** Keep the request delays polite, and check each store's terms of use before running this publicly. Scraping data and republishing it is a grey area, and the stores may object to a public site.
