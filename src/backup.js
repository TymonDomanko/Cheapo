// Daily database snapshots kept next to the database (DATA_DIR/backups).
// They protect against mistakes and corruption, not against losing the disk:
// for that, set up Litestream (see DEPLOY.md), which copies every change to
// cloud storage as it happens.

import fs from 'node:fs';
import path from 'node:path';
import { getDb, DB_FILE } from './db.js';

const KEEP = Number(process.env.BACKUP_KEEP_DAYS) || 7;

export function backupDir() {
  return process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups');
}

/** Write a consistent copy of the database (safe while the app is running). */
export function snapshot() {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `supermarket-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
  const file = path.join(dir, name);
  getDb().prepare('VACUUM INTO ?').run(file);
  prune();
  return { name, bytes: fs.statSync(file).size };
}

/** Keep the newest KEEP snapshots. */
function prune() {
  const files = listBackups();
  for (const f of files.slice(KEEP)) fs.rmSync(path.join(backupDir(), f.name), { force: true });
}

export function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^supermarket-[\dT-]+\.db$/.test(f))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, bytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Full path of a snapshot, refusing anything that isn't one of ours. */
export function backupPath(name) {
  if (!listBackups().some((b) => b.name === name)) return null;
  return path.join(backupDir(), name);
}

export function litestreamEnabled() {
  return !!process.env.LITESTREAM_BUCKET;
}

/** Where Litestream copies to (no secrets), for the admin page. Litestream starts before the app, so it's .env only. */
export function litestreamInfo() {
  if (!litestreamEnabled()) return { enabled: false };
  let host = null;
  try {
    host = process.env.LITESTREAM_ENDPOINT ? new URL(process.env.LITESTREAM_ENDPOINT).host : 'Amazon S3';
  } catch {
    host = process.env.LITESTREAM_ENDPOINT;
  }
  return { enabled: true, bucket: process.env.LITESTREAM_BUCKET, path: process.env.LITESTREAM_PATH || 'grocery', host };
}
