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

- **Update:** `docker compose pull && docker compose up -d`
- **Logs:** `docker compose logs -f app`
- **Back up:** copy the database out of the volume:
  `docker compose cp app:/data/supermarket.db ./backup.db`

A home connection is the most reliable place to scrape from, because Woolworths and ALDI don't block residential IPs.

## 2. Docker on a server with your own domain

What you need:

- a Linux server with Docker (any VPS, or a home server);
- a domain or subdomain with a DNS **A record** pointing at the server;
- ports **80 and 443** open.

The two files you need are in [`deploy/docker/`](deploy/docker):

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

## Disk space

The configs above create a **3 GB** disk. Most of the space goes on IGA, because each IGA store people pick keeps its own prices:

- about **2 MB per IGA store**, on top of a shared IGA catalogue (~0.5 KB per product);
- the four national chains together take roughly 30 MB.

With no cap (the default), every one of the ~540 IGAs with online prices would come to about 1.1 GB, plus price history that grows slowly as prices change. Set `IGA_MAX_STORES` if you want to limit it. The Admin page shows how many IGA stores are being followed.

## Scraping from the cloud

Coles, IGA and Harris Farm work from cloud servers. **Woolworths and ALDI sometimes block datacentre IP addresses.** If their refreshes fail on the Admin page, you have three options:

- **Use a residential proxy.** Set `HTTPS_PROXY=http://user:pass@host:port`. Only the scrapers use it.
- **Scrape from home into the server's database.** Run `npm run scrape -- woolworths aldi` on a home machine, then copy `supermarket.db` up. This works best if you schedule both steps.
- **Accept the gaps.** Run the site without those two stores' updates; the other three stores stay current.

## Checklist before going public

- [ ] You're behind HTTPS (options 2 and 3 do this for you).
- [ ] `ADMIN_EMAILS` is set, and you've signed up with that email.
- [ ] Remove the demo data if you loaded it: `docker compose exec app node src/cli/seed-demo.js --clear`.
- [ ] Decide on sign-ups. `ALLOW_SIGNUPS=false` keeps the site to people who already have an account.
- [ ] Back up `/data/supermarket.db`.
- [ ] Read each supermarket's terms of use. Republishing scraped prices publicly is a legal grey area.
