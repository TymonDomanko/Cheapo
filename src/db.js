import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { parseSizeFrom, altSize, unitPrice } from './units.js';

export const STORES = ['woolworths', 'coles', 'aldi'];

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

    CREATE TABLE IF NOT EXISTS shopping_list (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 1,
      match_mode TEXT NOT NULL DEFAULT 'similar', -- similar | exact | this
      added_at TEXT NOT NULL
    );

    -- Per-store manual choice for a list item. product_id NULL = never buy this item at that store.
    CREATE TABLE IF NOT EXISTS list_overrides (
      list_item_id INTEGER NOT NULL REFERENCES shopping_list(id) ON DELETE CASCADE,
      store TEXT NOT NULL,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      PRIMARY KEY (list_item_id, store)
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
}

const nowIso = () => new Date().toISOString();

/**
 * Insert or update a batch of scraped products and append a price_history row
 * whenever the price (or special status) differs from the last recorded one.
 * @returns {{upserted:number, priceChanges:number}}
 */
export function upsertProducts(store, items, seenAt = nowIso()) {
  const d = getDb();
  const getExisting = d.prepare('SELECT id FROM products WHERE store = ? AND store_product_id = ?');
  const insert = d.prepare(`
    INSERT INTO products (store, store_product_id, name, brand, size_text, size_qty, size_unit, alt_size_qty, alt_size_unit, per_weight,
      category, image_url, product_url, price, was_price, unit_price, unit_price_text, on_special, available,
      first_seen, last_seen)
    VALUES (@store, @store_product_id, @name, @brand, @size_text, @size_qty, @size_unit, @alt_size_qty, @alt_size_unit, @per_weight,
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
        store_product_id: String(raw.store_product_id),
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
export function markUnseenUnavailable(store, since) {
  return getDb()
    .prepare('UPDATE products SET available = 0 WHERE store = ? AND last_seen < ?')
    .run(store, since).changes;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export { nowIso };
