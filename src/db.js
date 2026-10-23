import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { parseSizeFrom, altSize, unitPrice } from './units.js';

export { STORES } from './stores.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'supermarket.db');

let db;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      store TEXT NOT NULL,
      store_product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT,
      size_text TEXT,
      size_qty REAL,
      size_unit TEXT,
      alt_size_qty REAL,
      alt_size_unit TEXT,
      per_weight INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      image_url TEXT,
      product_url TEXT,
      price REAL,
      was_price REAL,
      unit_price REAL,
      unit_price_text TEXT,
      on_special INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      UNIQUE (store, store_product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_products_size ON products (size_unit, size_qty);
    CREATE INDEX IF NOT EXISTS idx_products_alt_size ON products (alt_size_unit, alt_size_qty);
    CREATE INDEX IF NOT EXISTS idx_products_store ON products (store, last_seen);

    CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5 (
      name, brand, category, content='products', content_rowid='id',
      tokenize = 'porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
      INSERT INTO products_fts (rowid, name, brand, category) VALUES (new.id, new.name, new.brand, new.category);
    END;
    CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
      INSERT INTO products_fts (products_fts, rowid, name, brand, category) VALUES ('delete', old.id, old.name, old.brand, old.category);
    END;
    CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE OF name, brand, category ON products BEGIN
      INSERT INTO products_fts (products_fts, rowid, name, brand, category) VALUES ('delete', old.id, old.name, old.brand, old.category);
      INSERT INTO products_fts (rowid, name, brand, category) VALUES (new.id, new.name, new.brand, new.category);
    END;

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      price REAL NOT NULL,
      was_price REAL,
      on_special INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_product ON price_history (product_id, recorded_at);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Only a hash of the session token is stored, so a leaked database can't be used to log in.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      excluded_stores TEXT NOT NULL DEFAULT '[]', -- JSON array of store ids not to shop at
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS list_members (
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member', -- owner | member
      joined_at TEXT NOT NULL,
      PRIMARY KEY (list_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS list_invites (
      token TEXT PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS list_items (
      id INTEGER PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 1,
      match_mode TEXT NOT NULL DEFAULT 'similar', -- similar | exact | this
      added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      added_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items (list_id);

    -- Per-store manual choice for a list item. product_id NULL = never buy this item at that store.
    CREATE TABLE IF NOT EXISTS list_item_overrides (
      item_id INTEGER NOT NULL REFERENCES list_items(id) ON DELETE CASCADE,
      store TEXT NOT NULL,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      PRIMARY KEY (item_id, store)
    );

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY,
      store TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      products INTEGER NOT NULL DEFAULT 0,
      price_changes INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      log_json TEXT
    );
  `);
  // Columns added after the first release.
  const userCols = d.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('preferred_stores')) {
    d.exec('ALTER TABLE users ADD COLUMN preferred_stores TEXT'); // JSON array; NULL = all stores
  }
  if (!userCols.includes('iga_store')) d.exec('ALTER TABLE users ADD COLUMN iga_store TEXT');
  const listCols = d.prepare('PRAGMA table_info(lists)').all().map((c) => c.name);
  if (!listCols.includes('iga_store')) d.exec('ALTER TABLE lists ADD COLUMN iga_store TEXT');
  const runCols = d.prepare('PRAGMA table_info(scrape_runs)').all().map((c) => c.name);
  if (!runCols.includes('location')) d.exec('ALTER TABLE scrape_runs ADD COLUMN location TEXT');

  // Chains whose stores set their own prices (IGA) keep one row per product per
  // store: `location` is that store's id and store_product_id is "<location>:<id>".
  const productCols = d.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  if (!productCols.includes('location')) {
    d.exec('ALTER TABLE products ADD COLUMN location TEXT');
    const legacy = process.env.IGA_STORE_ID || '32600';
    d.prepare(`UPDATE products SET location = ?, store_product_id = ? || ':' || store_product_id
      WHERE store = 'iga' AND location IS NULL`).run(legacy, legacy);
  }
  d.exec('CREATE INDEX IF NOT EXISTS idx_products_location ON products (store, location)');

  d.exec(`
    -- IGA's store directory (refreshed weekly from igashop.com.au).
    CREATE TABLE IF NOT EXISTS iga_stores (
      id TEXT PRIMARY KEY,           -- IGA's retailerStoreId, used in their API
      name TEXT NOT NULL,
      address TEXT,
      suburb TEXT,
      state TEXT,
      postcode TEXT,
      lat REAL,
      lng REAL,
      updated_at TEXT NOT NULL
    );
    -- IGA stores whose prices we collect (because someone picked them).
    CREATE TABLE IF NOT EXISTS iga_tracked (
      store_id TEXT PRIMARY KEY,
      added_at TEXT NOT NULL,
      added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      last_scraped_at TEXT
    );
  `);
}

const nowIso = () => new Date().toISOString();

/**
 * Insert or update a batch of scraped products and append a price_history row
 * whenever the price (or special status) differs from the last recorded one.
 * @returns {{upserted:number, priceChanges:number}}
 */
/**
 * @param location  for per-store chains (IGA): which store these prices are from
 */
export function upsertProducts(store, items, seenAt = nowIso(), location = null) {
  const d = getDb();
  const getExisting = d.prepare('SELECT id FROM products WHERE store = ? AND store_product_id = ?');
  const insert = d.prepare(`
    INSERT INTO products (store, location, store_product_id, name, brand, size_text, size_qty, size_unit, alt_size_qty, alt_size_unit, per_weight,
      category, image_url, product_url, price, was_price, unit_price, unit_price_text, on_special, available,
      first_seen, last_seen)
    VALUES (@store, @location, @store_product_id, @name, @brand, @size_text, @size_qty, @size_unit, @alt_size_qty, @alt_size_unit, @per_weight,
      @category, @image_url, @product_url, @price, @was_price, @unit_price, @unit_price_text, @on_special, @available,
      @seen, @seen)`);
  const update = d.prepare(`
    UPDATE products SET name=@name, brand=@brand, size_text=@size_text, size_qty=@size_qty, size_unit=@size_unit,
      alt_size_qty=@alt_size_qty, alt_size_unit=@alt_size_unit, per_weight=@per_weight, category=COALESCE(@category, category), image_url=COALESCE(@image_url, image_url),
      product_url=COALESCE(@product_url, product_url), price=@price, was_price=@was_price, unit_price=@unit_price,
      unit_price_text=@unit_price_text, on_special=@on_special, available=@available, last_seen=@seen
    WHERE id=@id`);
  const lastPrice = d.prepare(
    'SELECT price, on_special FROM price_history WHERE product_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1');
  const addHistory = d.prepare(
    'INSERT INTO price_history (product_id, price, was_price, on_special, recorded_at) VALUES (?, ?, ?, ?, ?)');

  let upserted = 0;
  let priceChanges = 0;
  const run = d.transaction((rows) => {
    for (const raw of rows) {
      if (!raw || !raw.store_product_id || !raw.name) continue;
      const size = parseSizeFrom(raw.size_text, raw.name);
      const alt = altSize(raw.size_text, raw.name, size);
      const row = {
        store,
        location,
        store_product_id: location ? `${location}:${raw.store_product_id}` : String(raw.store_product_id),
        name: raw.name.trim(),
        brand: raw.brand || null,
        size_text: raw.size_text || null,
        size_qty: size?.qty ?? null,
        size_unit: size?.unit ?? null,
        alt_size_qty: alt?.qty ?? null,
        alt_size_unit: alt?.unit ?? null,
        per_weight: size?.perWeight ? 1 : 0,
        category: raw.category || null,
        image_url: raw.image_url || null,
        product_url: raw.product_url || null,
        price: num(raw.price),
        was_price: num(raw.was_price) || null,
        unit_price: num(raw.unit_price) ?? (size ? unitPrice(num(raw.price), size.qty, size.unit) : null),
        unit_price_text: raw.unit_price_text || null,
        on_special: raw.on_special ? 1 : 0,
        available: raw.available === false || num(raw.price) == null ? 0 : 1,
        seen: seenAt,
      };
      const existing = getExisting.get(store, row.store_product_id);
      let id;
      if (existing) {
        id = existing.id;
        update.run({ ...row, id });
      } else {
        id = insert.run(row).lastInsertRowid;
      }
      upserted++;
      if (row.price != null) {
        const last = lastPrice.get(id);
        if (!last || last.price !== row.price || last.on_special !== row.on_special) {
          addHistory.run(id, row.price, row.was_price, row.on_special, seenAt);
          if (last) priceChanges++;
        }
      }
    }
  });
  run(items);
  return { upserted, priceChanges };
}

/** After a complete crawl, anything not seen in it is no longer sold. */
export function markUnseenUnavailable(store, since, location = null) {
  return getDb()
    .prepare('UPDATE products SET available = 0 WHERE store = ? AND location IS ? AND last_seen < ?')
    .run(store, location, since).changes;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export { nowIso };
