# Configuration

Settings come from environment variables: a `.env` file with Docker Compose, or the container's variables on Unraid and cloud hosts. [`.env.example`](../.env.example) lists them with comments.

Settings marked **Admin page** can also be changed by an admin under **Admin → Site settings**. If one is set in `.env` too, the `.env` value wins and the Admin page shows it locked.

## The basics

| Variable | Default | What it does |
|---|---|---|
| `ADMIN_EMAILS` | — | Accounts with these emails (comma-separated) become admins when they sign up |
| `SITE_NAME` | `Cheapo` | The site's name: page title, header, the installed app and emails |
| `TZ` | server's | Time zone for the schedules, e.g. `Australia/Sydney` |
| `ALLOW_SIGNUPS` | `true` | `false` stops new sign-ups (existing accounts can still log in) |
| `PORT` | `3000` | The port the app listens on (inside the container) |
| `HOST_PORT`, `HOST_BIND` | `3000`, all addresses | Docker Compose only: the port on your machine, and `127.0.0.1` to keep it off the network |
| `PUID`, `PGID` | image's `node` user | Docker only: run as this user and group and own the data folder (Unraid: `99` and `100`) |
| `DATA_DIR` / `DB_PATH` | `data/` (`/data` in Docker) | Where the SQLite database, backups and collector programs live |

## Hosting publicly

| Variable | Default | What it does |
|---|---|---|
| `NODE_ENV` | — | `production` turns on HTTPS-only cookies |
| `SECURE_COOKIES` | `true` in production | `false` only when serving over plain `http://` on your own network |
| `TRUST_PROXY` | — | How many reverse proxies are in front (Caddy, nginx, Fly, Render…), for client addresses and HTTPS |
| `SITE_URL` | from the request | The public address, used in email links. **Admin page** |
| `SITE_OPERATOR`, `CONTACT_EMAIL` | — | Shown on the privacy page. **Admin page** |
| `API_RATE_LIMIT`, `SEARCH_RATE_LIMIT` | `300`, `90` | Requests per minute per address, for the whole API and for searches |
| `AUTH_RATE_LIMIT` | `20` | Sign-up, log-in and reset attempts per address per 15 minutes |

## Prices and refreshing

| Variable | Default | What it does |
|---|---|---|
| `SCRAPE_CRON` | `15 4 * * *` | When prices refresh, in `TZ`. Empty turns the schedule off |
| `IGA_STORE_ID` | `32600` | The IGA shown to visitors who haven't picked one |
| `IGA_MAX_STORES` | no limit | Cap on how many IGA stores' prices are collected. Each adds about 2 minutes to the refresh and about 2 MB |
| `BLOCKED_RETRY_HOURS` | `4` | When a shop blocks a crawl part-way (Coles), try again this much later, carrying on where it stopped (up to 4 times). `0` waits for the next scheduled refresh |
| `COLES_PAGES_PER_HOUR` | `30` | Coles is refreshed steadily, one page at a time, at most this many an hour **for this server and all collectors together** (see [how it works](how-it-works.md#coles-a-little-at-a-time)). `0` goes back to crawling all of Coles each night. **Admin page** |
| `COLES_FULL_EVERY_DAYS` | `2` | Steady mode: how often to go through the whole Coles shop, counted from when the last pass started (specials are done daily). For every Coles price within a day, set this to `1` and `COLES_PAGES_PER_HOUR` to `40` |
| `COLES_BARCODE_BUDGET` | `300` | Nightly mode only: Coles product pages fetched per day to fill in barcodes (steady mode fits them into spare time) |
| `WOOLWORTHS_CONCURRENCY` | `2` | Woolworths departments fetched at once, each in its own session |
| `IGA_CONCURRENCY` | `3` | IGA stores fetched at once |
| `*_DELAY_MS` | per shop | Pause between requests, e.g. `COLES_DELAY_MS=2500` |
| `*_SKIP_CATEGORIES` | per shop | Categories to leave out, comma-separated, e.g. `WOOLWORTHS_SKIP_CATEGORIES` |
| `SCRAPE_MODE` | `fetch` | `browser` fetches through a real Chromium (needs Playwright, which isn't in the Docker image) |
| `HTTPS_PROXY` | — | Send the scrapers' requests through a proxy (e.g. a residential one). Only the scrapers use it |

## Home collector

| Variable | Default | What it does |
|---|---|---|
| `COLLECTOR_TOKEN` | — | Lets a home collector send prices. Made for you when you download it from the Admin page. **Admin page** |
| `SERVER_SCRAPE_STORES` | all | The shops this server crawls itself, e.g. `coles,iga,harrisfarm`. The rest come from the collector. **Admin page** |
| `COLLECTOR_EXE_PREBUILT` | `/app/collector-exe` in Docker | A folder of ready-made collector programs |
| `NODE_DIST_MIRROR` | `https://nodejs.org/dist` | Where to download Node.js from when building collector programs |
| `COLLECTOR_CHECK_CRON` | `0 11 * * *` | When to check the collector has been sending prices |
| `COLLECT_STORES` | any | On a collector: only refresh these shops, e.g. `woolworths,aldi`. Unset, it does whatever the site asks |
| `COLLECT_COLES` | `true` | On a collector: `false` stops it fetching Coles pages for the site |

Helpers (collectors on other people's connections, each with its own token) are added on the Admin page; see [DEPLOY.md](../DEPLOY.md#sharing-the-work-helpers).

## Email

| Variable | Default | What it does |
|---|---|---|
| `SMTP_URL` | — | Any SMTP service, e.g. `smtps://user:password@smtp.example.com:465`. Without it, emails go to the Admin page's outbox. **Admin page** (set it here to keep the password out of the database) |
| `MAIL_FROM` | `SITE_NAME <no-reply@localhost>` | The "from" address. **Admin page** |
| `ADMIN_ALERTS` | `true` | Email admins a summary when a price refresh has problems, and when the home collector goes quiet |

## Backups

| Variable | Default | What it does |
|---|---|---|
| `BACKUP_KEEP_DAYS` | `7` | Nightly database snapshots to keep in `DATA_DIR/backups` |
| `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`, `LITESTREAM_REGION`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY` | — | Continuous off-site backup to S3-compatible storage. `.env` only, because Litestream starts before the app. See [DEPLOY.md](../DEPLOY.md#off-site-backups-litestream) |

## Ordering

On a public site, **Order cheapest** gives a per-shop list with links to each product, plus copy and print buttons. It doesn't buy anything. The shops have no public ordering APIs, and they can't be given your login.

When **self-hosting on your own computer**, set `ENABLE_TROLLEY_FILL=true` and run `npx playwright install chromium`. Admins then get a **Fill my trolleys automatically** button:
- It opens a browser on that machine, where you log in once.
- It adds the items to your Woolworths and Coles trolleys.
- It stops at the trolley, so you choose a delivery slot and pay yourself.

Keep this off on a public server.
