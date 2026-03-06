// src/routes/auth.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function genAddress() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let a = 'UQA';
  for (let i = 0; i < 30; i++) a += chars[Math.floor(Math.random() * chars.length)];
  return a + 'mush';
}

function makeToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

function initUserData(db, userId, address) {
  // game_state
  db.prepare(`
    INSERT OR IGNORE INTO game_state (user_id) VALUES (?)
  `).run(userId);

  // wallet TON
  db.prepare(`
    INSERT OR IGNORE INTO wallets (id, user_id, address, currency, balance)
    VALUES (?, ?, ?, 'TON', 5.0)
  `).run(uuidv4(), userId, address);

  // wallet MYCO
  db.prepare(`
    INSERT OR IGNORE INTO wallets (id, user_id, address, currency, balance)
    VALUES (?, ?, ?, 'MYCO', 250)
  `).run(uuidv4(), userId, address + '_myco');

  // starter cards
  const starterCards = [
    { rarity: 'common',   base: 2,  color: '#8e9aaf', name: 'Shroom Basique' },
    { rarity: 'common',   base: 2,  color: '#8e9aaf', name: 'Shroom Basique' },
    { rarity: 'uncommon', base: 5,  color: '#3ecf6a', name: 'Pleurote Pro' },
  ];
  const insertCard = db.prepare(`
    INSERT INTO cards (id, user_id, rarity, name, level, xp, xp_needed, mushrooms_per_cycle, base_mushrooms, color)
    VALUES (?, ?, ?, ?, 1, 0, 100, ?, ?, ?)
  `);
  for (const c of starterCards) {
    insertCard.run(uuidv4(), userId, c.rarity, c.name, c.base * 1, c.base, c.color);
  }

  // welcome bonus transaction
  db.prepare(`
    INSERT INTO transactions (user_id, label, amount, currency, icon)
    VALUES (?, 'Welcome Bonus', 250, 'myco', '🎁')
  `).run(userId);
}

// ── POST /auth/register ───────────────────────────────────────────────────────
router.post('/register', (req, res) => {
  const { username, password, lang, theme, referral_code } = req.body;

  if (!username || username.length < 2 || username.length > 16) {
    return res.status(400).json({ error: 'Nom invalide (2-16 caractères)' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Nom déjà pris' });
  }

  const id      = uuidv4();
  const address = genAddress();
  const hash    = password ? bcrypt.hashSync(password, 10) : null;

  const insertUser = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, username, password_hash, lang, theme, address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, username, hash, lang || 'fr', theme || 'dark', address);

    initUserData(db, id, address);

    // Handle referral
    if (referral_code) {
      const referrer = db.prepare('SELECT id FROM users WHERE id = ?').get(referral_code);
      if (referrer) {
        db.prepare(`
          INSERT OR IGNORE INTO referrals (referrer_id, referred_id) VALUES (?, ?)
        `).run(referrer.id, id);
        // Give bonus to referrer
        db.prepare(`
          UPDATE wallets SET balance = balance + 500
          WHERE user_id = ? AND currency = 'MYCO'
        `).run(referrer.id);
        db.prepare(`
          UPDATE game_state SET myco = myco + 500 WHERE user_id = ?
        `).run(referrer.id);
        db.prepare(`
          INSERT INTO transactions (user_id, label, amount, currency, icon)
          VALUES (?, 'Bonus Parrainage', 500, 'myco', '🎁')
        `).run(referrer.id);
        // Mark referral bonus given
        db.prepare(`
          UPDATE referrals SET bonus_given = 1 WHERE referrer_id = ? AND referred_id = ?
        `).run(referrer.id, id);
      }
    }
  });

  insertUser();
  const token = makeToken(id);
  res.status(201).json({ token, userId: id, username, address });
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: 'Nom requis' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (!user.is_active) return res.status(403).json({ error: 'Compte désactivé' });

  // If password set, verify it
  if (user.password_hash) {
    if (!password) return res.status(401).json({ error: 'Mot de passe requis' });
    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect' });
  }

  db.prepare('UPDATE users SET last_login = unixepoch() WHERE id = ?').run(user.id);
  const token = makeToken(user.id);
  res.json({ token, userId: user.id, username: user.username, address: user.address });
});

// ── POST /auth/telegram ───────────────────────────────────────────────────────
// Used when the game is embedded in a Telegram Mini App
router.post('/telegram', (req, res) => {
  const { telegram_id, username, lang } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id requis' });

  const db = getDb();
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegram_id));

  if (!user) {
    // Auto-register
    const id      = uuidv4();
    const uname   = username || `Farmer_${telegram_id}`;
    const address = genAddress();
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, username, telegram_id, lang, theme, address)
        VALUES (?, ?, ?, ?, 'dark', ?)
      `).run(id, uname, String(telegram_id), lang || 'fr', address);
      initUserData(db, id, address);
    });
    tx();
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  db.prepare('UPDATE users SET last_login = unixepoch() WHERE id = ?').run(user.id);
  const token = makeToken(user.id);
  res.json({ token, userId: user.id, username: user.username, address: user.address });
});

// ── GET /auth/me ─────────────────────────────────────────────────────────────
router.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT id, username, lang, theme, address, created_at, last_login
    FROM users WHERE id = ?
  `).get(req.userId);
  res.json(user);
});

module.exports = router;
