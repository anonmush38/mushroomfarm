// src/db/database.js
// SQLite database setup with better-sqlite3

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './data/mushroom_farm.db';

// Ensure data directory exists
const dataDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function getDb() {
  if (!db) {
    db = new Database(path.resolve(DB_PATH));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    -- ============================================================
    -- USERS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      username    TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      telegram_id TEXT UNIQUE,
      lang        TEXT NOT NULL DEFAULT 'fr',
      theme       TEXT NOT NULL DEFAULT 'dark',
      address     TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      last_login  INTEGER NOT NULL DEFAULT (unixepoch()),
      is_active   INTEGER NOT NULL DEFAULT 1
    );

    -- ============================================================
    -- GAME STATE (one row per user, full snapshot)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS game_state (
      user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      myco              REAL    NOT NULL DEFAULT 250,
      ton               REAL    NOT NULL DEFAULT 5.0,
      total_harvested   INTEGER NOT NULL DEFAULT 0,
      pending_myco      REAL    NOT NULL DEFAULT 0,
      pending_count     INTEGER NOT NULL DEFAULT 0,
      exchange_direction TEXT   NOT NULL DEFAULT 'ton_to_myco',
      last_midnight_reward INTEGER,
      last_free_spin       INTEGER,
      last_free_slot_spin  INTEGER,
      last_daily_gift      INTEGER,
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ============================================================
    -- FARM SLOTS (50 slots per user)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS farm_slots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot_index   INTEGER NOT NULL,
      card_id      TEXT,
      farming_since INTEGER,
      UNIQUE(user_id, slot_index)
    );

    -- ============================================================
    -- UNLOCKED SLOTS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS unlocked_slots (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot_index INTEGER NOT NULL,
      PRIMARY KEY(user_id, slot_index)
    );

    -- ============================================================
    -- CARDS (inventory)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS cards (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rarity              TEXT NOT NULL,
      name                TEXT NOT NULL,
      level               INTEGER NOT NULL DEFAULT 1,
      xp                  INTEGER NOT NULL DEFAULT 0,
      xp_needed           INTEGER NOT NULL DEFAULT 100,
      mushrooms_per_cycle INTEGER NOT NULL,
      base_mushrooms      INTEGER NOT NULL,
      color               TEXT,
      farming_since       INTEGER,
      cycle_ready         INTEGER NOT NULL DEFAULT 0,
      slot_index          INTEGER,
      created_at          INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ============================================================
    -- BASKET (harvested mushrooms per rarity)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS basket (
      user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rarity   TEXT NOT NULL,
      amount   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, rarity)
    );

    -- ============================================================
    -- TRANSACTIONS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS transactions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label      TEXT NOT NULL,
      amount     REAL NOT NULL,
      currency   TEXT NOT NULL,
      icon       TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ============================================================
    -- REWARD HISTORY (daily gifts, spins, etc.)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS reward_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      reward     TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ============================================================
    -- CRYPTO WALLETS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS wallets (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      address      TEXT NOT NULL UNIQUE,
      currency     TEXT NOT NULL DEFAULT 'TON',
      balance      REAL NOT NULL DEFAULT 0,
      locked       REAL NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ============================================================
    -- WITHDRAW REQUESTS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS withdraw_requests (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      currency        TEXT NOT NULL,
      amount          REAL NOT NULL,
      to_address      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      tx_hash         TEXT,
      note            TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      processed_at    INTEGER
    );

    -- ============================================================
    -- REFERRALS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS referrals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bonus_given   INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(referred_id)
    );

    -- ============================================================
    -- INDEXES
    -- ============================================================
    CREATE INDEX IF NOT EXISTS idx_cards_user        ON cards(user_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_farm_slots_user   ON farm_slots(user_id);
    CREATE INDEX IF NOT EXISTS idx_withdraw_user     ON withdraw_requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallets_user      ON wallets(user_id);
  `);

  // Seed default basket rarities for new users via trigger
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS init_basket_after_gamestate
    AFTER INSERT ON game_state
    BEGIN
      INSERT OR IGNORE INTO basket(user_id, rarity, amount) VALUES
        (NEW.user_id, 'common',    0),
        (NEW.user_id, 'uncommon',  0),
        (NEW.user_id, 'rare',      0),
        (NEW.user_id, 'epic',      0),
        (NEW.user_id, 'legendary', 0);
    END;
  `);
}

module.exports = { getDb };
