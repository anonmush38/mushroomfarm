// routes/wallet.js
// Système hybride : dépôt blockchain → crédit in-game / retrait in-game → tx blockchain

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb }  = require('../db/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const ton        = require('../ton/tonClient');

const router = express.Router();

const MIN_WITHDRAW_TON  = parseFloat(process.env.MIN_WITHDRAW_TON  || '0.5');
const MIN_WITHDRAW_MYCO = parseFloat(process.env.MIN_WITHDRAW_MYCO || '1000');
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET || 'mf_webhook_secret_change_me';

// Auth sur toutes les routes sauf webhook
router.use((req, res, next) => {
  if (req.path === '/webhook/deposit') return next();
  authMiddleware(req, res, next);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet  — soldes complets
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const db  = getDb();
  const uid = req.userId;
  const gs  = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  const user = db.prepare('SELECT address, telegram_id FROM users WHERE id = ?').get(uid);
  const adminAddr = await ton.getAdminWalletAddress();

  res.json({
    address:         user?.address,
    game_myco:       gs?.myco  || 0,
    game_ton:        gs?.ton   || 0,
    deposit_address: adminAddr || null,
    deposit_memo:    user?.telegram_id || uid.slice(0, 8),
    myco_contract:   ton.MYCO_CONTRACT,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet/balances/:address  — vrais soldes blockchain
// ─────────────────────────────────────────────────────────────────────────────
router.get('/balances/:address', async (req, res) => {
  const { address } = req.params;
  const [tonBal, mycoBal] = await Promise.all([
    ton.getTonBalance(address),
    ton.getMycoBalance(address),
  ]);
  res.json({
    address,
    ton:  tonBal,
    myco: mycoBal,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet/deposit-address
// ─────────────────────────────────────────────────────────────────────────────
router.get('/deposit-address', async (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(req.userId);
  const adminAddr = await ton.getAdminWalletAddress();

  if (!adminAddr) return res.status(503).json({ error: 'Adresse de dépôt non configurée' });

  res.json({
    address:     adminAddr,
    memo:        user?.telegram_id || req.userId.slice(0, 8),
    memo_label:  'Commentaire obligatoire',
    min_deposit: 0.1,
    network:     'TON',
    myco_contract: ton.MYCO_CONTRACT,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/withdraw  — retrait avec tx blockchain automatique
// ─────────────────────────────────────────────────────────────────────────────
router.post('/withdraw', async (req, res) => {
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

  if (!to_address.match(/^[UE]Q[A-Za-z0-9_\-]{46}$/)) {
    return res.status(400).json({ error: 'Adresse TON invalide' });
  }

  const gs = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  if (!gs) return res.status(404).json({ error: 'Partie introuvable' });

  const available = cur === 'TON' ? gs.ton : gs.myco;
  if (available < amount) {
    return res.status(400).json({ error: `Solde insuffisant (${available.toFixed(2)} ${cur})` });
  }

  const reqId  = uuidv4();
  let txResult = null;
  let autoSent = false;

  // ── Débiter le compte AVANT d'envoyer la tx ───────────────────────────────
  db.transaction(() => {
    if (cur === 'TON') {
      db.prepare('UPDATE game_state SET ton = ton - ?, updated_at = unixepoch() WHERE user_id = ?').run(amount, uid);
      db.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'TON'`).run(amount, uid);
    } else {
      db.prepare('UPDATE game_state SET myco = myco - ?, updated_at = unixepoch() WHERE user_id = ?').run(amount, uid);
      db.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'MYCO'`).run(amount, uid);
    }
    db.prepare(`INSERT INTO withdraw_requests (id, user_id, currency, amount, to_address, status) VALUES (?,?,?,?,?,'pending')`).run(reqId, uid, cur, amount, to_address);
    db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,?,'📤')`).run(uid, `Retrait ${cur} (en cours...)`, -amount, cur.toLowerCase());
  })();

  // ── Tenter l'envoi automatique TON ───────────────────────────────────────
  if (cur === 'TON') {
    try {
      txResult = await ton.sendTon(to_address, amount, `Retrait MushroomFarm`);
      autoSent = true;
      // Mettre à jour le statut
      db.prepare(`UPDATE withdraw_requests SET status='completed', tx_hash=?, processed_at=unixepoch() WHERE id=?`)
        .run(String(txResult.seqno), reqId);
      db.prepare(`UPDATE transactions SET label=? WHERE user_id=? AND label=?`)
        .run(`Retrait TON envoyé (seqno: ${txResult.seqno})`, uid, `Retrait ${cur} (en cours...)`);
      console.log(`[Withdraw] ✅ ${amount} TON → ${to_address}`);
    } catch(e) {
      console.error('[Withdraw] Erreur tx:', e.message);
      // Retrait en attente de traitement manuel si l'envoi auto échoue
    }
  }

  res.json({
    ok:         true,
    request_id: reqId,
    status:     autoSent ? 'completed' : 'pending',
    message:    autoSent
      ? `✅ ${amount} ${cur} envoyés vers votre wallet !`
      : `⏳ Retrait de ${amount} ${cur} enregistré — traitement sous 24h.`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/webhook/deposit  — webhook toncenter (backup au polling)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook/deposit', async (req, res) => {
  const { secret, tx_hash, from_address, amount_ton, comment } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!tx_hash || !amount_ton || amount_ton <= 0) return res.status(400).json({ error: 'Paramètres manquants' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM deposits WHERE tx_hash = ?').get(tx_hash);
  if (existing) return res.json({ ok: true, duplicate: true });

  let user = null;
  if (comment) user = db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(comment.trim());
  if (!user) return res.json({ ok: false, reason: 'Joueur non identifié' });

  db.transaction(() => {
    db.prepare('UPDATE game_state SET ton = ton + ?, updated_at = unixepoch() WHERE user_id = ?').run(amount_ton, user.id);
    db.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'TON'`).run(amount_ton, user.id);
    db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,'ton','📥')`).run(user.id, `Dépôt TON (${tx_hash.slice(0,12)}...)`, amount_ton);
    db.prepare(`INSERT OR IGNORE INTO deposits (id, user_id, tx_hash, from_address, amount, currency, status) VALUES (?,?,?,?,?,'TON','confirmed')`).run(uuidv4(), user.id, tx_hash, from_address || '', amount_ton);
  })();

  res.json({ ok: true, credited: amount_ton });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/exchange  — échange in-game
// ─────────────────────────────────────────────────────────────────────────────
router.post('/exchange', (req, res) => {
  const db  = getDb();
  const uid = req.userId;
  const { direction, amount } = req.body;
  if (!direction || !amount || amount <= 0) return res.status(400).json({ error: 'Paramètres invalides' });

  const RATES = {
    ton_to_myco: { from: 'ton',  to: 'myco', rate: 1000  },
    myco_to_ton: { from: 'myco', to: 'ton',  rate: 0.001 },
  };
  const exch = RATES[direction];
  if (!exch) return res.status(400).json({ error: 'Direction inconnue' });

  const gs = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  if (!gs) return res.status(404).json({ error: 'Partie introuvable' });

  const fromBal = exch.from === 'ton' ? gs.ton : gs.myco;
  if (fromBal < amount) return res.status(400).json({ error: `Solde insuffisant` });

  const gained = amount * exch.rate;
  db.transaction(() => {
    if (exch.from === 'ton') {
      db.prepare('UPDATE game_state SET ton=ton-?, myco=myco+?, updated_at=unixepoch() WHERE user_id=?').run(amount, gained, uid);
    } else {
      db.prepare('UPDATE game_state SET myco=myco-?, ton=ton+?, updated_at=unixepoch() WHERE user_id=?').run(amount, gained, uid);
    }
    db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,?,'🔄')`).run(uid, `Échange ${exch.from.toUpperCase()}→${exch.to.toUpperCase()}`, gained, exch.to);
  })();

  const updated = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  res.json({ ok: true, gained, new_myco: updated.myco, new_ton: updated.ton });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet/withdraw  — historique
// ─────────────────────────────────────────────────────────────────────────────
router.get('/withdraw', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM withdraw_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(req.userId));
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/ton-address
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ton-address', (req, res) => {
  const { ton_wallet_address } = req.body;
  if (!ton_wallet_address) return res.status(400).json({ error: 'Adresse manquante' });
  getDb().prepare('UPDATE users SET address = ? WHERE id = ?').run(ton_wallet_address, req.userId);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — retraits en attente
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/withdraw/pending', adminMiddleware, (req, res) => {
  const db = getDb();
  res.json(db.prepare(`SELECT wr.*, u.username FROM withdraw_requests wr JOIN users u ON u.id=wr.user_id WHERE wr.status='pending' ORDER BY wr.created_at ASC`).all());
});

router.post('/admin/withdraw/:id/process', adminMiddleware, async (req, res) => {
  const db = getDb();
  const { status, tx_hash, note } = req.body;
  const request = db.prepare('SELECT * FROM withdraw_requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Demande introuvable' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Déjà traitée' });

  let finalTxHash = tx_hash;

  // Envoi automatique si pas de tx_hash fourni et c'est du TON
  if (status === 'completed' && !tx_hash && request.currency === 'TON') {
    try {
      const result = await ton.sendTon(request.to_address, request.amount, 'Retrait MushroomFarm');
      finalTxHash = String(result.seqno);
    } catch(e) {
      return res.status(500).json({ error: `Erreur envoi tx: ${e.message}` });
    }
  }

  db.transaction(() => {
    db.prepare(`UPDATE withdraw_requests SET status=?, tx_hash=?, note=?, processed_at=unixepoch() WHERE id=?`).run(status, finalTxHash || null, note || null, request.id);
    if (status === 'rejected') {
      if (request.currency === 'TON') {
        db.prepare('UPDATE game_state SET ton=ton+?, updated_at=unixepoch() WHERE user_id=?').run(request.amount, request.user_id);
      } else {
        db.prepare('UPDATE game_state SET myco=myco+?, updated_at=unixepoch() WHERE user_id=?').run(request.amount, request.user_id);
      }
      db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,?,'↩️')`).run(request.user_id, `Retrait ${request.currency} rejeté - remboursé`, request.amount, request.currency.toLowerCase());
    }
  })();

  res.json({ ok: true, status, tx_hash: finalTxHash });
});

module.exports = router;
