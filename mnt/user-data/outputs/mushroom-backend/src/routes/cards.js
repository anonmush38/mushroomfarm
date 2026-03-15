// src/routes/cards.js
// Card management: list, buy, upgrade, merge, sell, deploy, retire

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const CARD_TYPES = [
  { rarity: 'common',    name: 'Shroom Basique',   base_mushrooms: 2,   shop_price: 50,  shop_currency: 'myco', upgrade_cost: 20,   color: '#8e9aaf', myco_per_mushroom: 1  },
  { rarity: 'uncommon',  name: 'Pleurote Pro',      base_mushrooms: 5,   shop_price: 150, shop_currency: 'myco', upgrade_cost: 60,   color: '#3ecf6a', myco_per_mushroom: 2  },
  { rarity: 'rare',      name: 'Truffe Sacrée',     base_mushrooms: 12,  shop_price: 500, shop_currency: 'myco', upgrade_cost: 200,  color: '#4da6ff', myco_per_mushroom: 5  },
  { rarity: 'epic',      name: 'Amanite Épique',    base_mushrooms: 35,  shop_price: 2,   shop_currency: 'ton',  upgrade_cost: 500,  color: '#b44fff', myco_per_mushroom: 12 },
  { rarity: 'legendary', name: 'Shroom Légendaire', base_mushrooms: 100, shop_price: 10,  shop_currency: 'ton',  upgrade_cost: 2000, color: '#ff8c00', myco_per_mushroom: 30 },
];

function getType(rarity) { return CARD_TYPES.find(c => c.rarity === rarity); }

// ── GET /cards ────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db    = getDb();
  const cards = db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY created_at').all(req.userId);
  res.json(cards);
});

// ── POST /cards/buy ───────────────────────────────────────────────────────────
router.post('/buy', (req, res) => {
  const db   = getDb();
  const uid  = req.userId;
  const { rarity } = req.body;

  const type = getType(rarity);
  if (!type) return res.status(400).json({ error: 'Rareté inconnue' });

  const gs = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  if (!gs) return res.status(404).json({ error: 'Partie introuvable' });

  try {
    db.transaction(() => {
      if (type.shop_currency === 'myco') {
        if (gs.myco < type.shop_price) throw new Error('Pas assez de MYCO');
        db.prepare('UPDATE game_state SET myco = myco - ?, updated_at = unixepoch() WHERE user_id = ?').run(type.shop_price, uid);
        db.prepare(`UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND currency = 'MYCO'`).run(type.shop_price, uid);
      } else {
        if (gs.ton < type.shop_price) throw new Error('Pas assez de TON');
        db.prepare('UPDATE game_state SET ton = ton - ?, updated_at = unixepoch() WHERE user_id = ?').run(type.shop_price, uid);
        db.prepare(`UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND currency = 'TON'`).run(type.shop_price, uid);
      }

      db.prepare(`
        INSERT INTO cards (id, user_id, rarity, name, level, xp, xp_needed, mushrooms_per_cycle, base_mushrooms, color)
        VALUES (?, ?, ?, ?, 1, 0, 100, ?, ?, ?)
      `).run(uuidv4(), uid, type.rarity, type.name, type.base_mushrooms, type.base_mushrooms, type.color);

      db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,?,'🛒')`).run(uid, `Achat: ${type.name}`, -type.shop_price, type.shop_currency);
    })();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json({ ok: true });
});

// ── POST /cards/:id/upgrade ───────────────────────────────────────────────────
router.post('/:id/upgrade', (req, res) => {
  const db   = getDb();
  const uid  = req.userId;
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, uid);

  if (!card)              return res.status(404).json({ error: 'Carte introuvable' });
  if (card.level >= 100)  return res.status(400).json({ error: 'Niveau maximum' });

  const type     = getType(card.rarity);
  const cost     = type.upgrade_cost * card.level;
  const gs       = db.prepare('SELECT myco FROM game_state WHERE user_id = ?').get(uid);

  if (gs.myco < cost) return res.status(400).json({ error: 'Pas assez de MYCO' });

  const newLevel = card.level + 1;
  const newMpc   = type.base_mushrooms * newLevel;

  db.transaction(() => {
    db.prepare('UPDATE game_state SET myco = myco - ?, updated_at = unixepoch() WHERE user_id = ?').run(cost, uid);
    db.prepare(`UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND currency = 'MYCO'`).run(cost, uid);
    db.prepare(`UPDATE cards SET level = ?, xp = 0, xp_needed = ?, mushrooms_per_cycle = ? WHERE id = ? AND user_id = ?`).run(newLevel, newLevel * 100, newMpc, card.id, uid);
    db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,?,'⬆️')`).run(uid, `Upgrade: ${card.name}`, -cost, 'myco');
  })();

  res.json({ ok: true, new_level: newLevel, new_mpc: newMpc });
});

// ── POST /cards/merge ─────────────────────────────────────────────────────────
router.post('/merge', (req, res) => {
  const db       = getDb();
  const uid      = req.userId;
  const { base_id, sacrifice_id } = req.body;

  const base      = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(base_id, uid);
  const sacrifice = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(sacrifice_id, uid);

  if (!base || !sacrifice)               return res.status(404).json({ error: 'Carte introuvable' });
  if (base.rarity !== sacrifice.rarity)  return res.status(400).json({ error: 'Raretés différentes' });
  if (base.level >= 100)                 return res.status(400).json({ error: 'Niveau maximum' });
  if (sacrifice.slot_index !== null)     return res.status(400).json({ error: 'Carte déployée sur un slot' });

  const type     = getType(base.rarity);
  const newLevel = base.level + 1;
  const newMpc   = type.base_mushrooms * newLevel;

  db.transaction(() => {
    db.prepare('DELETE FROM cards WHERE id = ?').run(sacrifice.id);
    db.prepare(`UPDATE cards SET level = ?, xp = 0, xp_needed = ?, mushrooms_per_cycle = ? WHERE id = ?`).run(newLevel, newLevel * 100, newMpc, base.id);
  })();

  res.json({ ok: true, new_level: newLevel });
});

// ── POST /cards/:id/sell ──────────────────────────────────────────────────────
router.post('/:id/sell', (req, res) => {
  const db   = getDb();
  const uid  = req.userId;
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, uid);

  if (!card)                        return res.status(404).json({ error: 'Carte introuvable' });
  if (card.slot_index !== null)     return res.status(400).json({ error: 'Retire la carte du slot avant de vendre' });

  const sellShrooms = card.mushrooms_per_cycle;

  db.transaction(() => {
    db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
    db.prepare(`
      INSERT INTO basket (user_id, rarity, amount) VALUES (?,?,?)
      ON CONFLICT(user_id, rarity) DO UPDATE SET amount = amount + excluded.amount
    `).run(uid, card.rarity, sellShrooms);
    db.prepare('UPDATE game_state SET total_harvested = total_harvested + ? WHERE user_id = ?').run(sellShrooms, uid);
    db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,'shrooms','🍄')`).run(uid, `Vente carte: ${card.name}`, sellShrooms);
  })();

  res.json({ ok: true, gained_shrooms: sellShrooms });
});

// ── POST /cards/:id/deploy ────────────────────────────────────────────────────
router.post('/:id/deploy', (req, res) => {
  const db  = getDb();
  const uid = req.userId;
  const { slot_index } = req.body;

  if (slot_index === undefined) return res.status(400).json({ error: 'slot_index requis' });

  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!card) return res.status(404).json({ error: 'Carte introuvable' });

  const existingSlot = db.prepare('SELECT * FROM farm_slots WHERE user_id = ? AND slot_index = ?').get(uid, slot_index);
  if (existingSlot?.card_id) return res.status(409).json({ error: 'Slot déjà occupé' });

  const now = Date.now();
  db.transaction(() => {
    db.prepare('UPDATE cards SET slot_index = ?, farming_since = ? WHERE id = ?').run(slot_index, now, card.id);
    db.prepare(`
      INSERT INTO farm_slots (user_id, slot_index, card_id, farming_since) VALUES (?,?,?,?)
      ON CONFLICT(user_id, slot_index) DO UPDATE SET card_id = excluded.card_id, farming_since = excluded.farming_since
    `).run(uid, slot_index, card.id, now);
  })();

  res.json({ ok: true, farming_since: now });
});

// ── POST /cards/:id/retire ────────────────────────────────────────────────────
router.post('/:id/retire', (req, res) => {
  const db   = getDb();
  const uid  = req.userId;
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, uid);

  if (!card) return res.status(404).json({ error: 'Carte introuvable' });

  db.transaction(() => {
    if (card.slot_index !== null) {
      db.prepare('UPDATE farm_slots SET card_id = NULL, farming_since = NULL WHERE user_id = ? AND slot_index = ?').run(uid, card.slot_index);
    }
    db.prepare('UPDATE cards SET slot_index = NULL, farming_since = NULL, cycle_ready = 0 WHERE id = ?').run(card.id);
  })();

  res.json({ ok: true });
});

module.exports = router;
