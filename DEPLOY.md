# Deploying

There are three ways to run the site. They all use the same Docker image and keep everything in one SQLite file on a persistent disk.

| Option | Best for | HTTPS | Rough cost |
|---|---|---|---|
| [1. Docker on your own machine](#1-docker-on-your-own-machine) | Just you, or your household on your home network | No (local network) | Free |
| [2. Docker on a server with a domain](#2-docker-on-a-server-with-your-own-domain) | A public site on a VPS or home server | Automatic (Caddy + Let's Encrypt) | VPS from ~A$6/month |
| [3. Cloud platform](#3-cloud-platform-flyio-or-render) | A public site without managing a server | Automatic | ~US$5–7/month |

In every option you become admin the same way: put your email in `ADMIN_EMAILS`, then **sign up on the site with that email**.

## The Docker image

Each push to `main` runs the tests, then builds and publishes the image to GitHub Container Registry:

```
ghcr.io/tymondomanko/supermarket-tools:latest
```

The workflow is `.github/workflows/docker-publish.yml`. It builds for `amd64` (most servers) and `arm64` (Raspberry Pi, ARM VPSs). Tagging a release `v1.2.3` also publishes `:1.2.3`.

Before using the published image the first time:

1. **Merge to `main`** (or run the workflow from the Actions tab) so the image gets built.
2. **Make the package public.** GitHub makes new packages private. On GitHub, go to your profile, then **Packages**, then **supermarket-tools**, then **Package settings**, then **Change visibility** to **Public**. If you'd rather keep it private, run `docker login ghcr.io` on each machine that pulls it.

You can also skip the registry and build from a checkout. Both Docker options below work with `docker compose up -d --build`.

---

## 1. Docker on your own machine

```bash
git clone https://github.com/tymondomanko/supermarket-tools.git
cd supermarket-tools
cp .env.example .env
```

Edit `.env`:

- set `ADMIN_EMAILS=you@example.com`;
- **if you'll open the site over plain `http://` from other devices on your network**, set `SECURE_COOKIES=false`. Otherwise logging in won't stick, because the session cookie is HTTPS-only. `http://localhost` works either way.

```bash
docker compose up -d
```

Open http://localhost:3000, sign up with your admin email, then go to **Admin** and press **Refresh all prices**. The first full refresh takes 20–60 minutes.

**Ports.** Set these in `.env` if 3000 is taken or you want something else:
- `HOST_PORT=8080`: the port on your machine (the site is then at http://localhost:8080).
- `HOST_BIND=127.0.0.1`: only this machine can reach it, e.g. when your own nginx or Caddy sits in front.
- `PORT`: the app's port inside the container. You rarely need to change it.

Then run `docker compose up -d` again to apply.

- **Update:** `docker compose pull && docker compose up -d`
- **Logs:** `docker compose logs -f app`
- **Back up:** copy the database out of the volume:
  `docker compose cp app:/data/supermarket.db ./backup.db`

A home connection is the most reliable place to scrape from, because Woolworths and ALDI don't block residential IPs.

### On Unraid

Use the **Compose Manager** plugin (or Portainer) with this, swapping in your share's name. This example uses a share called `supermarket`:

```yaml
services:
  app:
    image: ghcr.io/tymondomanko/supermarket-tools:latest
    container_name: supermarket
    restart: unless-stopped
    ports:
      - "3000:3000"        # or e.g. "8085:3000" if 3000 is taken
    env_file: .env
    environment:
      PUID: "99"           # files in the share stay owned by nobody:users,
      PGID: "100"          # like the rest of Unraid
    volumes:
      - /mnt/user/supermarket:/data
```

There's no `volumes:` section at the bottom: the data goes straight into the share. That folder then holds the database (`supermarket.db`), its daily backups and the cached collector programs. Back it up like any other share.

## 2. Docker on a server with your own domain

What you need:

- a Linux server with Docker (any VPS, or a home server);
- a domain or subdomain with a DNS **A record** pointing at the server;
- ports **80 and 443** open.

If 80 and 443 are already used on that machine, set `HTTP_PORT` and `HTTPS_PORT` in `.env` to other ports. Something in front, such as your router's port forwarding, still has to send the internet's ports 80 and 443 to them, because Let's Encrypt only checks the standard ports. Caddy finds the app automatically if you change `PORT`.

The files you need are in [`deploy/docker/`](deploy/docker):

```bash
mkdir grocery && cd grocery
curl -fsSLO https://raw.githubusercontent.com/tymondomanko/supermarket-tools/main/deploy/docker/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/tymondomanko/supermarket-tools/main/deploy/docker/Caddyfile
curl -fsSL  https://raw.githubusercontent.com/tymondomanko/supermarket-tools/main/deploy/docker/.env.example -o .env
nano .env          # set DOMAIN and ADMIN_EMAILS
docker compose up -d
```

Caddy gets an HTTPS certificate for `DOMAIN` automatically, and Watchtower installs new versions of the image every night at 3am. Delete the `watchtower` service from the compose file if you'd rather update by hand.

## 3. Cloud platform (Fly.io or Render)

Both build the Dockerfile in this repo and attach a persistent disk for the database. **Run a single instance.** SQLite, the rate limiter and the daily refresh schedule all assume one server.

### Fly.io (Sydney region)

Install the [flyctl CLI](https://fly.io/docs/flyctl/install/), then from the repo:

```bash
fly launch --copy-config --no-deploy     # choose a unique app name when asked
fly volumes create grocery_data --region syd --size 3
fly secrets set ADMIN_EMAILS=you@example.com
fly deploy
fly open
```

The settings are in [`fly.toml`](fly.toml). The machine stays running so the daily refresh fires, and `/healthz` is the health check. To use your own domain, run `fly certs add groceries.example.com` and follow the DNS instructions it prints.

### Render

1. In the Render dashboard, choose **New → Blueprint**, then pick this repository. Render reads [`render.yaml`](render.yaml).
2. Enter your email for `ADMIN_EMAILS` when asked, then press **Apply**.
3. When the deploy finishes, open the `.onrender.com` URL and sign up with that email.

Render's free instances can't have a persistent disk, so the Blueprint uses the **Starter** plan. Render has no Australian region; Singapore is the closest.

### Other platforms

Any host that runs a Dockerfile with a persistent volume works: Railway, DigitalOcean App Platform, Google Cloud Run with a mounted volume, and so on. Set these:

- **Volume:** mounted at `/data`.
- **Environment:** `NODE_ENV=production`, `TRUST_PROXY=1`, `ADMIN_EMAILS=…`, `TZ=Australia/Sydney`.
- **Health check:** `GET /healthz`.
- **Port:** `3000` (or set `PORT`).
- **Always on**, so the daily refresh runs.

Platforms without persistent disks, such as Vercel, Netlify and Heroku, would need the database moved to PostgreSQL.

---

## Email (password resets, confirmation, alerts)

The app writes and sends its own emails. It needs an email service's SMTP details to deliver them; Resend, Postmark, Amazon SES, Mailgun and Brevo all provide them, and most free tiers cover a household-sized site.

**Easiest:** on the Admin page, under **Site settings → Email**, enter:
- the mail server, port, username and password;
- the "from" address;
- the site's address, used for links in emails.

Then press **Send test email**. If it fails, the page says why, e.g. a wrong password or a mismatched port and secure setting.

**Or in `.env`**, which takes priority over the Admin page and keeps the password out of the database and its backups:

```
SMTP_URL=smtps://USERNAME:PASSWORD@smtp.example.com:465
MAIL_FROM=Grocery Price Compare <alerts@groceries.example.com>
SITE_URL=https://groceries.example.com
```

Without a mail server, nothing is sent. Emails appear in the Admin page's **Emails** section instead, so you can pass a reset link on to someone by hand.

What gets sent:
- confirmation of new accounts' emails;
- password resets;
- price alerts, daily after prices refresh;
- the "on special this week" email, Wednesdays at 8am.

Alerts only go to confirmed addresses, and every alert email has a one-click unsubscribe link.

## Off-site backups (Litestream)

The server snapshots its database every night into `/data/backups`, keeping 7 days. Admins can download those from the Admin page. They sit on the same disk as the database, though, so they don't help if the disk is lost.

For that, the Docker image includes [Litestream](https://litestream.io). It copies every change to S3-compatible storage within seconds, and if it starts on an empty disk it restores the latest copy before the app starts. Set:

```
LITESTREAM_BUCKET=my-grocery-backups
LITESTREAM_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com   # leave out for AWS S3
LITESTREAM_REGION=auto                                                # or your AWS region
LITESTREAM_ACCESS_KEY_ID=...
LITESTREAM_SECRET_ACCESS_KEY=...
```

Litestream starts before the app, so it can restore the database onto a new server, which means these settings can only go in `.env`. The Admin page shows whether it's on and where it copies to. Cloudflare R2 and Backblaze B2 are cheapest; a site this size fits in their free tiers. The Admin page shows whether off-site backup is on.

**To restore onto a new server:** start the container with the same `LITESTREAM_*` settings and an empty `/data`.

## Home collector (Woolworths and ALDI)

Woolworths and ALDI sometimes block cloud servers. The fix is to crawl them from a home connection and send the results to your site.

**Easiest: download it from the Admin page.**

1. Go to **Admin → Site settings → Home collector** and untick Woolworths and ALDI under "This server crawls". Save.
2. Press the download button for the computer that will run it. Every download is already set up for your site: its address, a collector token, and the stores you unticked.
   - **Windows** or **Linux (x64 / ARM, e.g. a Raspberry Pi):** a single program. Nothing to install. Run it and leave it running: it collects once straight away, then every day at 4am Sydney time.
     - Windows may say it's from an unknown publisher, because it isn't code-signed. Choose **More info → Run anyway**.
     - On Linux it comes as a `.tar.gz` (so it stays executable): `tar xzf grocery-collector-linux-x64.tar.gz && ./grocery-collector`.
     - To start it with the computer, run it once with `--autostart` (undo with `--no-autostart`). On Windows this adds it to the Startup folder; on a Linux desktop it adds a log-in entry. On a Linux server, use a systemd service instead (below).
   - **Mac / zip:** for a Mac, or any computer with [Node.js 20+](https://nodejs.org). Unzip it and run `sh start.sh` (or `start.bat` on Windows). Its settings are in the `.env` file inside; `COLLECT_CRON` sets the time.

**It keeps itself up to date.**
- Before each collection, it asks your site for the latest collector version. If there's a newer one, it downloads it, checks the code matches the version fingerprint, and restarts with it.
- The single program keeps the collector's code in your app-data folder (`%LOCALAPPDATA%\GroceryCollector` on Windows, `~/.local/share/grocery-collector` on Linux). It fetches the latest code each time it starts, and uses the saved copy if your site can't be reached. You never need to download the program again, unless you make a new token.
- The zip version replaces its own files instead; its `.env` is never touched. Set `AUTO_UPDATE=false` there to turn updating off.

**Where the programs come from.** Each program is the official Node.js binary from nodejs.org (checked against its published SHA-256 sums) with the small launcher in `src/collector-launcher.cjs` added. It uses Node's single-executable-application feature. Your site's address and token are appended to the end of each download.
- The Docker image comes with the programs ready-made.
- Otherwise the server builds each one the first time someone asks for it. This takes about a minute and needs roughly 1 GB of free memory and access to nodejs.org; it's cached under `DATA_DIR/collector-exe` afterwards.
- On a small server where building fails, build them on another machine: `node src/cli/build-collector-exe.js --prebuild collector-exe`, then copy that folder to the app folder (or point `COLLECTOR_EXE_PREBUILT` at it). Alternatively, use the zip.
- There's no Mac program because Apple only runs programs that were signed on a Mac.

**Linux server with systemd.** Put the program in `/opt/grocery-collector/` and create `/etc/systemd/system/grocery-collector.service`:

```ini
[Unit]
Description=Grocery home collector
After=network-online.target

[Service]
ExecStart=/opt/grocery-collector/grocery-collector
User=nobody
Environment=GROCERY_COLLECTOR_HOME=/var/lib/grocery-collector
StateDirectory=grocery-collector
Restart=always

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl enable --now grocery-collector`.

**Checking on it.** The Admin page shows when the collector last connected, how it's run, and whether it's up to date. It also warns if it hasn't connected for more than a day and a half.

**Docker instead.** Use [`deploy/collector/`](deploy/collector): copy `.env.example` to `.env` and fill in `COLLECTOR_SERVER` and the token from the Admin page's `.env`, then run `docker compose up -d`. A Docker collector can't replace its own code. The Admin page tells you when to run `docker compose pull && docker compose up -d`.

The token inside the downloaded program (or the zip's `.env`) is what lets it send prices, so don't share the download. If it's ever exposed, press **Generate a new token** and download the collector again.

## The daily refresh

At `SCRAPE_CRON` (04:15 by default, in `TZ`) the server:

1. **Checks which IGAs have prices online.** It reloads IGA's store list and asks each of the ~540 stores for a product, which takes about 8 minutes. Stores that start publishing prices show up in the IGA picker. Stores that stop are hidden, and their prices stop being fetched.
2. **Refreshes prices** for every supermarket (except the ones a home collector sends) and every followed IGA store.
3. **Fills in Coles barcodes:** up to `COLES_BARCODE_BUDGET` product pages a day (default 1,500), products on lists first. This lets Coles products match Woolworths ones exactly.
4. **Sends price alerts** to people whose watched products got cheaper.

If the server was off at that time, the IGA check runs when it next starts. Admins can also run it from the Admin page with **Check now**.

**How long it takes.** Measured on real crawls from a cloud server:
- **Woolworths:** about 15 minutes. Two departments at a time (`WOOLWORTHS_CONCURRENCY`), each in a fresh session.
- **IGA:** about 3 minutes per store, three stores at a time (`IGA_CONCURRENCY`).
- **ALDI and Harris Farm:** about a minute each.
- **Coles:** about 30 minutes or more. Coles challenges a server after roughly every 30 requests however slowly they're made, and gets stricter as a crawl goes on. The crawler tries a fresh session first, then waits, and skips a department that stays blocked (the rest is saved). Coles is far more relaxed with home internet connections, so if Coles refreshes keep failing, let the home collector fetch Coles too.

**When something goes wrong, admins hear about it.** Every admin is emailed when:
- a shop's refresh fails, or finds less than 70% of the products the previous one did (usually the shop changed its website or started blocking the server);
- the home collector hasn't sent prices for a day and a half (checked daily at 11:00, `COLLECTOR_CHECK_CRON`).

While prices are refreshing, nothing is sent straight away: problems (and fixes) are collected and emailed as **one summary** a couple of minutes after the last shop finishes, with a line on how each shop's refresh went. Each problem is reported once, then at most daily while it lasts, and again when it's fixed. Open problems also show at the top of **Admin → Data health**, alongside how fresh each shop's data is and how much of it can be compared. These emails need email set up (above). Turn them off with `ADMIN_ALERTS=false`.

## Disk space

The configs above create a **3 GB** disk. Most of the space goes on IGA, because each IGA store people pick keeps its own prices:

- about **2 MB per IGA store**, on top of a shared IGA catalogue (~0.5 KB per product);
- the four national chains together take roughly 30 MB.

With no cap (the default), every one of the ~540 IGAs with online prices would come to about 1.1 GB, plus price history that grows slowly as prices change. Set `IGA_MAX_STORES` if you want to limit it. The Admin page shows how many IGA stores are being followed.

## Scraping from the cloud

Coles, IGA and Harris Farm work from cloud servers. **Woolworths and ALDI sometimes block datacentre IP addresses.** If their refreshes fail on the Admin page:

- **Run the home collector** (above). This is the simplest dependable fix.
- **Or use a residential proxy.** Set `HTTPS_PROXY=http://user:pass@host:port`. Only the scrapers use it.

## Checklist before going public

- [ ] You're behind HTTPS (options 2 and 3 do this for you).
- [ ] `ADMIN_EMAILS` is set, and you've signed up with that email.
- [ ] Remove the demo data if you loaded it: `docker compose exec app node src/cli/seed-demo.js --clear`.
- [ ] Decide on sign-ups. `ALLOW_SIGNUPS=false` keeps the site to people who already have an account.
- [ ] Email is set up (Admin → Site settings, or `.env`) and the test email arrives. Or you're happy to hand out reset links from the admin outbox.
- [ ] Off-site backup is on (`LITESTREAM_*`). The Admin page says so.
- [ ] The privacy page's contact email and "run by" name are filled in (Admin → Site settings).
- [ ] Read each supermarket's terms of use. Republishing scraped prices publicly is a legal grey area.
