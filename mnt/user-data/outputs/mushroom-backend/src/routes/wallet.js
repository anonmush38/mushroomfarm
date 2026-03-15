// src/routes/wallet.js
// Crypto wallet management: balances, exchange MYCO↔TON, withdraw requests

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const MIN_WITHDRAW_TON  = parseFloat(process.env.MIN_WITHDRAW_TON  || '0.1');
const MIN_WITHDRAW_MYCO = parseFloat(process.env.MIN_WITHDRAW_MYCO || '100');

// ── GET /wallet ───────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db  = getDb();
  const uid = req.userId;

  const wallets = db.prepare('SELECT * FROM wallets WHERE user_id = ?').all(uid);
  const gs      = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  const user    = db.prepare('SELECT address, ton_wallet_address FROM users WHERE id = ?').get(uid);

  const result = {
    address:            user?.address,
    ton_wallet_address: user?.ton_wallet_address || null,
    balances:           {},
    wallets,
  };

  for (const w of wallets) {
    result.balances[w.currency] = {
      available: w.balance,
      locked:    w.locked,
      total:     w.balance + w.locked,
    };
  }

  if (gs) {
    result.game_myco = gs.myco;
    result.game_ton  = gs.ton;
  }

  res.json(result);
});

// ── POST /wallet/ton-address ──────────────────────────────────────────────────
// Persiste l'adresse TON réelle connectée via TonConnect.
// Appelé par le frontend dès qu'un wallet est connecté (onStatusChange).
router.post('/ton-address', (req, res) => {
  const { ton_wallet_address } = req.body;

  if (!ton_wallet_address) {
    return res.status(400).json({ error: 'ton_wallet_address requis' });
  }

  // Validation format adresse TON (EQ.../UQ...)
  if (!ton_wallet_address.match(/^[UE]Q[A-Za-z0-9_-]{46}$/)) {
    return res.status(400).json({ error: 'Format d\'adresse TON invalide' });
  }

  getDb().prepare('UPDATE users SET ton_wallet_address = ? WHERE id = ?')
    .run(ton_wallet_address, req.userId);

  res.json({ ok: true, ton_wallet_address });
});

// ── POST /wallet/exchange ─────────────────────────────────────────────────────
router.post('/exchange', (req, res) => {
  const db  = getDb();
  const uid = req.userId;
  const { direction, amount } = req.body;

  if (!direction || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }

  const gs = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  if (!gs) return res.status(404).json({ error: 'Partie introuvable' });

  const RATES = {
    ton_to_myco: { from: 'ton',  to: 'myco', rate: 1000  },
    myco_to_ton: { from: 'myco', to: 'ton',  rate: 0.001 },
  };

  const exch = RATES[direction];
  if (!exch) return res.status(400).json({ error: 'Direction inconnue' });

  const fromBalance = exch.from === 'ton' ? gs.ton : gs.myco;
  if (fromBalance < amount) {
    return res.status(400).json({ error: `Solde insuffisant en ${exch.from.toUpperCase()}` });
  }

  const gained = amount * exch.rate;

  db.transaction(() => {
    if (exch.from === 'ton') {
      db.prepare('UPDATE game_state SET ton = ton - ?, myco = myco + ?, updated_at = unixepoch() WHERE user_id = ?').run(amount, gained, uid);
      db.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'TON'`).run(amount, uid);
      db.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'MYCO'`).run(gained, uid);
    } else {
      db.prepare('UPDATE game_state SET myco = myco - ?, ton = ton + ?, updated_at = unixepoch() WHERE user_id = ?').run(amount, gained, uid);
      db.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'MYCO'`).run(amount, uid);
      db.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'TON'`).run(gained, uid);
    }
    db.prepare(`
      INSERT INTO transactions (user_id, label, amount, currency, icon)
      VALUES (?, ?, ?, ?, '🔄')
    `).run(uid, `Échange ${exch.from.toUpperCase()} → ${exch.to.toUpperCase()}`, gained, exch.to);
  })();

  const updated = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  res.json({ ok: true, gained, new_myco: updated.myco, new_ton: updated.ton });
});

// ── POST /wallet/withdraw ─────────────────────────────────────────────────────
router.post('/withdraw', (req, res) => {
  const db  = getDb();
  const uid = req.userId;
  const { currency, amount, to_address } = req.body;

  if (!currency || !amount || !to_address) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  const cur = currency.toUpperCase();
  if (!['TON', 'MYCO'].includes(cur)) {
    return res.status(400).json({ error: 'Devise inconnue' });
  }

  const minAmount = cur === 'TON' ? MIN_WITHDRAW_TON : MIN_WITHDRAW_MYCO;
  if (amount < minAmount) {
    return res.status(400).json({ error: `Montant minimum: ${minAmount} ${cur}` });
  }

  if (cur === 'TON' && !to_address.match(/^[UE]Q[A-Za-z0-9_-]{46}$/)) {
    return res.status(400).json({ error: 'Adresse TON invalide' });
  }

  const gs = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  if (!gs) return res.status(404).json({ error: 'Partie introuvable' });

  const available = cur === 'TON' ? gs.ton : gs.myco;
  if (available < amount) {
    return res.status(400).json({ error: `Solde insuffisant (${available.toFixed(2)} ${cur} disponible)` });
  }

  const reqId = uuidv4();

  db.transaction(() => {
    if (cur === 'TON') {
      db.prepare('UPDATE game_state SET ton = ton - ?, updated_at = unixepoch() WHERE user_id = ?').run(amount, uid);
      db.prepare(`UPDATE wallets SET balance = balance - ?, locked = locked + ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'TON'`).run(amount, amount, uid);
    } else {
      db.prepare('UPDATE game_state SET myco = myco - ?, updated_at = unixepoch() WHERE user_id = ?').run(amount, uid);
      db.prepare(`UPDATE wallets SET balance = balance - ?, locked = locked + ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'MYCO'`).run(amount, amount, uid);
    }
    db.prepare(`INSERT INTO withdraw_requests (id, user_id, currency, amount, to_address, status) VALUES (?, ?, ?, ?, ?, 'pending')`).run(reqId, uid, cur, amount, to_address);
    db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?, ?, ?, ?, '📤')`).run(uid, `Retrait ${cur} (en attente)`, -amount, cur.toLowerCase());
  })();

  res.json({
    ok: true,
    request_id: reqId,
    status:     'pending',
    message:    'Demande de retrait enregistrée. Traitement sous 24-48h.',
  });
});

// ── GET /wallet/withdraw ──────────────────────────────────────────────────────
router.get('/withdraw', (req, res) => {
  const db = getDb();
  const requests = db.prepare(`
    SELECT * FROM withdraw_requests WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 20
  `).all(req.userId);
  res.json(requests);
});

// ── GET /wallet/withdraw/:id ──────────────────────────────────────────────────
router.get('/withdraw/:id', (req, res) => {
  const db      = getDb();
  const request = db.prepare(`SELECT * FROM withdraw_requests WHERE id = ? AND user_id = ?`).get(req.params.id, req.userId);
  if (!request) return res.status(404).json({ error: 'Demande introuvable' });
  res.json(request);
});

// ── POST /wallet/deposit ──────────────────────────────────────────────────────
// Simulation dépôt (en production : webhook TON blockchain)
router.post('/deposit', (req, res) => {
  const db = getDb();
  const { currency, amount, tx_hash } = req.body;
  if (!currency || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }

  const cur = currency.toUpperCase();
  db.transaction(() => {
    if (cur === 'TON') {
      db.prepare('UPDATE game_state SET ton = ton + ?, updated_at = unixepoch() WHERE user_id = ?').run(amount, req.userId);
      db.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'TON'`).run(amount, req.userId);
    } else {
      db.prepare('UPDATE game_state SET myco = myco + ?, updated_at = unixepoch() WHERE user_id = ?').run(amount, req.userId);
      db.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'MYCO'`).run(amount, req.userId);
    }
    db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?, ?, ?, ?, '📥')`).run(
      req.userId,
      `Dépôt ${cur}${tx_hash ? ' (' + tx_hash.substring(0, 10) + '...)' : ''}`,
      amount,
      cur.toLowerCase()
    );
  })();

  res.json({ ok: true });
});

// ── ADMIN: traiter un retrait ─────────────────────────────────────────────────
router.post('/admin/withdraw/:id/process', adminMiddleware, (req, res) => {
  const db = getDb();
  const { status, tx_hash, note } = req.body;

  const request = db.prepare('SELECT * FROM withdraw_requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Demande introuvable' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Demande déjà traitée' });

  db.transaction(() => {
    db.prepare(`
      UPDATE withdraw_requests
      SET status = ?, tx_hash = ?, note = ?, processed_at = unixepoch()
      WHERE id = ?
    `).run(status, tx_hash || null, note || null, request.id);

    const cur = request.currency;
    if (status === 'rejected') {
      if (cur === 'TON') {
        db.prepare('UPDATE game_state SET ton = ton + ?, updated_at = unixepoch() WHERE user_id = ?').run(request.amount, request.user_id);
        db.prepare(`UPDATE wallets SET balance = balance + ?, locked = locked - ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'TON'`).run(request.amount, request.amount, request.user_id);
      } else {
        db.prepare('UPDATE game_state SET myco = myco + ?, updated_at = unixepoch() WHERE user_id = ?').run(request.amount, request.user_id);
        db.prepare(`UPDATE wallets SET balance = balance + ?, locked = locked - ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'MYCO'`).run(request.amount, request.amount, request.user_id);
      }
      db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,?,'↩️')`).run(request.user_id, `Retrait ${cur} rejeté - remboursé`, request.amount, cur.toLowerCase());
    } else {
      // completed : déverrouiller le montant
      db.prepare(`UPDATE wallets SET locked = locked - ?, updated_at = unixepoch() WHERE user_id = ? AND currency = ?`).run(request.amount, request.user_id, cur);
    }
  })();

  res.json({ ok: true, status });
});

// ── ADMIN: liste des retraits en attente ──────────────────────────────────────
router.get('/admin/withdraw/pending', adminMiddleware, (req, res) => {
  const db = getDb();
  const pending = db.prepare(`
    SELECT wr.*, u.username FROM withdraw_requests wr
    JOIN users u ON u.id = wr.user_id
    WHERE wr.status = 'pending'
    ORDER BY wr.created_at ASC
  `).all();
  res.json(pending);
});

module.exports = router;
