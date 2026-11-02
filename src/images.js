// Product photos, served from this site (/img/<product id>) rather than each
// shop's image server: some shoppers' networks can't reach a shop's images
// (Woolworths' refuses some), and a copy here loads faster. The first time a
// photo is asked for, this server fetches it and keeps a copy next to the
// database; only photos of products in the database can be fetched, so it
// can't be used to fetch anything else.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, DB_FILE } from './db.js';

const DIR = path.join(path.dirname(DB_FILE), 'images');
const MAX_BYTES = 3 * 1024 * 1024;
const KEEP_DAYS = Number(process.env.IMAGE_CACHE_DAYS) || 60;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const fetching = new Map(); // url → promise, so a photo is fetched once however many ask
const failed = new Map(); // url → when it last failed: don't keep asking a shop for a broken photo

// What a file is, from its first bytes. Shops' servers don't always say it
// properly (Coles' says "image/jpg"), so the bytes decide.
function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]/.test(buf.subarray(8, 12).toString('latin1'))) return 'image/avif';
  return null;
}

const fileFor = (url) => path.join(DIR, crypto.createHash('sha256').update(url).digest('hex').slice(0, 32));

/** The product's photo as a file here: { file, type }, or null if there isn't one (or it can't be fetched). */
export async function productImage(id) {
  const row = getDb().prepare('SELECT image_url FROM products WHERE id = ?').get(Number(id));
  const url = row?.image_url;
  if (!url || !(/^https:\/\//.test(url) || (process.env.IMAGES_ALLOW_HTTP === 'true' && /^http:\/\//.test(url)))) return null;
  const base = fileFor(url);
  for (const ext of Object.values(TYPES)) {
    if (fs.existsSync(`${base}.${ext}`)) return { file: `${base}.${ext}`, type: Object.keys(TYPES).find((t) => TYPES[t] === ext) };
  }
  if (Date.now() - (failed.get(url) || 0) < 3600 * 1000) return null;
  if (!fetching.has(url)) {
    fetching.set(url, download(url, base).catch(() => {
      failed.set(url, Date.now());
      return null;
    }).finally(() => fetching.delete(url)));
  }
  return fetching.get(url);
}

async function download(url, base) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) throw new Error('empty or too big');
  const type = sniff(buf);
  if (!type) throw new Error(`not a photo (${res.headers.get('content-type')})`);
  fs.mkdirSync(DIR, { recursive: true });
  const file = `${base}.${TYPES[type]}`;
  fs.writeFileSync(`${file}.tmp`, buf);
  fs.renameSync(`${file}.tmp`, file);
  return { file, type };
}

/** Daily: forget photos not fetched for a while (they're fetched again when next wanted). */
export function pruneImages() {
  if (!fs.existsSync(DIR)) return 0;
  const before = Date.now() - KEEP_DAYS * 86400000;
  let n = 0;
  for (const f of fs.readdirSync(DIR)) {
    const p = path.join(DIR, f);
    try {
      if (fs.statSync(p).mtimeMs < before) {
        fs.rmSync(p, { force: true });
        n++;
      }
    } catch {
      /* gone already */
    }
  }
  return n;
}
