// src/routes/game.js
// Full game state save / load + per-action endpoints

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// ── GET /game/state ───────────────────────────────────────────────────────────
// Load complete game state for the authenticated user
router.get('/state', (req, res) => {
  const db = getDb();
  const uid = req.userId;

  const gs = db.prepare('SELECT * FROM game_state WHERE user_id = ?').get(uid);
  if (!gs) return res.status(404).json({ error: 'Partie introuvable' });

  const cards = db.prepare('SELECT * FROM cards WHERE user_id = ?').all(uid);
  const slots = db.prepare('SELECT * FROM farm_slots WHERE user_id = ? ORDER BY slot_index').all(uid);
  const unlockedSlots = db.prepare('SELECT slot_index FROM unlocked_slots WHERE user_id = ?').all(uid).map(r => r.slot_index);
  const basket = db.prepare('SELECT rarity, amount FROM basket WHERE user_id = ?').all(uid);
  const txs = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(uid);
  const rewardHistory = db.prepare('SELECT * FROM reward_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(uid);

  // Build slots array (50 slots)
  const slotsArray = Array(50).fill(null);
  for (const s of slots) {
    if (s.card_id) {
      const card = cards.find(c => c.id === s.card_id);
      if (card) {
        slotsArray[s.slot_index] = {
          ...card,
          farming_since: s.farming_since,
        };
      }
    }
  }

  // Basket as object
  const basketObj = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 };
  for (const b of basket) basketObj[b.rarity] = b.amount;

  // Wallet cards = cards not in any slot
  const occupiedCardIds = new Set(slots.filter(s => s.card_id).map(s => s.card_id));
  const walletCards = cards.filter(c => !occupiedCardIds.has(c.id)).map(c => ({
    ...c,
    farming_since: null,
    cycle_ready: false,
  }));

  res.json({
    player:               req.username,
    myco:                 gs.myco,
    ton:                  gs.ton,
    total_harvested:      gs.total_harvested,
    pending_myco:         gs.pending_myco,
    pending_count:        gs.pending_count,
    exchange_direction:   gs.exchange_direction,
    last_midnight_reward: gs.last_midnight_reward,
    last_free_spin:       gs.last_free_spin,
    last_free_slot_spin:  gs.last_free_slot_spin,
    last_daily_gift:      gs.last_daily_gift,
    slots:                slotsArray,
    wallet_cards:         walletCards,
    unlocked_slots:       unlockedSlots,
    basket:               basketObj,
    transactions:         txs.map(tx => ({
      label:    tx.label,
      amount:   tx.amount,
      currency: tx.currency,
      icon:     tx.icon,
      time:     new Date(tx.created_at * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    })),
    reward_history: rewardHistory,
    address: db.prepare('SELECT address FROM users WHERE id = ?').get(uid)?.address,
  });
});

// ── POST /game/state ──────────────────────────────────────────────────────────
// Full state sync from client (saves entire game state)
router.post('/state', (req, res) => {
  const db = getDb();
  const uid = req.userId;
  const s = req.body;

  if (!s) return res.status(400).json({ error: 'State manquant' });

  const save = db.transaction(() => {
    // Update game_state
    db.prepare(`
      UPDATE game_state SET
        myco = ?, ton = ?, total_harvested = ?,
        pending_myco = ?, pending_count = ?,
        exchange_direction = ?,
        last_midnight_reward = ?, last_free_spin = ?,
        last_free_slot_spin = ?, last_daily_gift = ?,
        updated_at = unixepoch()
      WHERE user_id = ?
    `).run(
      s.myco ?? 0, s.ton ?? 0, s.total_harvested ?? 0,
      s.pending_myco ?? 0, s.pending_count ?? 0,
      s.exchange_direction || 'ton_to_myco',
      s.last_midnight_reward || null, s.last_free_spin || null,
      s.last_free_slot_spin || null, s.last_daily_gift || null,
      uid
    );

    // Sync wallets
    db.prepare(`UPDATE wallets SET balance = ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'MYCO'`).run(s.myco ?? 0, uid);
    db.prepare(`UPDATE wallets SET balance = ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'TON'`).run(s.ton ?? 0, uid);

    // Basket
    const rarities = ['common','uncommon','rare','epic','legendary'];
    const upsertBasket = db.prepare(`
      INSERT INTO basket (user_id, rarity, amount) VALUES (?,?,?)
      ON CONFLICT(user_id, rarity) DO UPDATE SET amount = excluded.amount
    `);
    if (s.basket) {
      for (const r of rarities) {
        upsertBasket.run(uid, r, s.basket[r] ?? 0);
      }
    }

    // Unlocked slots
    db.prepare('DELETE FROM unlocked_slots WHERE user_id = ?').run(uid);
    if (Array.isArray(s.unlocked_slots)) {
      const insertSlot = db.prepare('INSERT OR IGNORE INTO unlocked_slots (user_id, slot_index) VALUES (?,?)');
      for (const idx of s.unlocked_slots) insertSlot.run(uid, idx);
    }

    // Cards - full resync
    db.prepare('DELETE FROM cards WHERE user_id = ?').run(uid);
    const insertCard = db.prepare(`
      INSERT INTO cards (id, user_id, rarity, name, level, xp, xp_needed,
        mushrooms_per_cycle, base_mushrooms, color, farming_since, cycle_ready, slot_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const allCards = [
      ...(s.wallet_cards || []).map(c => ({ ...c, slot_index: null })),
      ...(s.slots || []).filter(Boolean).map((c, i) => ({ ...c, slot_index: i })),
    ];

    for (const c of allCards) {
      const cardId = c.id || uuidv4();
      insertCard.run(
        cardId, uid, c.rarity, c.name, c.level || 1, c.xp || 0,
        c.xp_needed || 100, c.mushrooms_per_cycle, c.base_mushrooms,
        c.color || null, c.farming_since || null, c.cycle_ready ? 1 : 0,
        c.slot_index ?? null
      );
    }

    // Farm slots
    db.prepare('DELETE FROM farm_slots WHERE user_id = ?').run(uid);
    const insertFarmSlot = db.prepare('INSERT INTO farm_slots (user_id, slot_index, card_id, farming_since) VALUES (?,?,?,?)');
    if (s.slots) {
      s.slots.forEach((card, i) => {
        if (card) {
          insertFarmSlot.run(uid, i, card.id, card.farming_since || null);
        }
      });
    }
  });

  save();
  res.json({ ok: true, saved_at: Date.now() });
});

// ── POST /game/harvest ────────────────────────────────────────────────────────
router.post('/harvest', (req, res) => {
  const db = getDb();
  const uid = req.userId;
  const { slot_indices, mushrooms_gained, basket_delta } = req.body;

  db.transaction(() => {
    // Update basket
    if (basket_delta) {
      const upsert = db.prepare(`
        INSERT INTO basket (user_id, rarity, amount) VALUES (?,?,?)
        ON CONFLICT(user_id, rarity) DO UPDATE SET amount = amount + excluded.amount
      `);
      for (const [rarity, amt] of Object.entries(basket_delta)) {
        if (amt > 0) upsert.run(uid, rarity, amt);
      }
    }
    // Update total_harvested
    if (mushrooms_gained > 0) {
      db.prepare('UPDATE game_state SET total_harvested = total_harvested + ?, updated_at = unixepoch() WHERE user_id = ?').run(mushrooms_gained, uid);
    }
    // Reset farming_since on harvested slots
    if (Array.isArray(slot_indices)) {
      const now = Math.floor(Date.now() / 1000);
      const update = db.prepare('UPDATE farm_slots SET farming_since = ? WHERE user_id = ? AND slot_index = ?');
      for (const idx of slot_indices) update.run(now * 1000, uid, idx);
    }
    // Log transaction
    db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,'shrooms','🍄')`).run(uid, 'Récolte', mushrooms_gained || 0);
  })();

  res.json({ ok: true });
});

// ── POST /game/transaction ────────────────────────────────────────────────────
router.post('/transaction', (req, res) => {
  const db = getDb();
  const { label, amount, currency, icon } = req.body;
  if (!label || amount === undefined || !currency) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }
  db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,?,?)`).run(req.userId, label, amount, currency, icon || null);
  res.json({ ok: true });
});

// ── GET /game/transactions ────────────────────────────────────────────────────
router.get('/transactions', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const txs = db.prepare(`
    SELECT * FROM transactions WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(req.userId, limit, offset);
  res.json(txs);
});

// ── POST /game/reward ─────────────────────────────────────────────────────────
router.post('/reward', (req, res) => {
  const db = getDb();
  const { type, reward } = req.body;
  db.prepare(`INSERT INTO reward_history (user_id, type, reward) VALUES (?,?,?)`).run(req.userId, type, JSON.stringify(reward));

  // Update last_* timestamps
  const field = {
    free_spin:      'last_free_spin',
    free_slot_spin: 'last_free_slot_spin',
    daily_gift:     'last_daily_gift',
    midnight:       'last_midnight_reward',
  }[type];
  if (field) {
    db.prepare(`UPDATE game_state SET ${field} = unixepoch() WHERE user_id = ?`).run(req.userId);
  }
  res.json({ ok: true });
});

// ── GET /game/leaderboard ────────────────────────────────────────────────────
router.get('/leaderboard', (req, res) => {
  const db = getDb();
  const top = db.prepare(`
    SELECT u.username, gs.total_harvested, gs.myco, gs.ton
    FROM game_state gs
    JOIN users u ON u.id = gs.user_id
    WHERE u.is_active = 1
    ORDER BY gs.total_harvested DESC
    LIMIT 50
  `).all();
  res.json(top);
});

module.exports = router;
