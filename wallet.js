// src/routes/wallet.js
// Système hybride : dépôt blockchain → crédit in-game / retrait in-game → tx blockchain

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// ── Config ────────────────────────────────────────────────────────────────────
const MIN_WITHDRAW_TON  = parseFloat(process.env.MIN_WITHDRAW_TON  || '0.5');
const MIN_WITHDRAW_MYCO = parseFloat(process.env.MIN_WITHDRAW_MYCO || '1000');
const ADMIN_WALLET      = process.env.ADMIN_TON_WALLET || '';   // Adresse TON du wallet admin
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';  // Clé API toncenter.com
const TONCENTER_URL     = 'https://toncenter.com/api/v2';
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET || 'mf_webhook_secret_change_me';

// ── Auth sur toutes les routes sauf webhook ───────────────────────────────────
router.use((req, res, next) => {
  if (req.path === '/webhook/deposit') return next(); // webhook pas d'auth JWT
  authMiddleware(req, res, next);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet/deposit-address
// Retourne l'adresse de dépôt du joueur (= adresse admin + memo = telegram_id)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/deposit-address', (req, res) => {
  const db  = getDb();
  const uid = req.userId;

  const user = db.prepare('SELECT telegram_id, address FROM users WHERE id = ?').get(uid);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  if (!ADMIN_WALLET) {
    return res.status(503).json({ error: 'Adresse de dépôt non configurée' });
  }

  // Le memo permet au webhook d'identifier quel joueur a fait le dépôt
  const memo = user.telegram_id || uid.slice(0, 8);

  res.json({
    address:     ADMIN_WALLET,
    memo:        memo,
    memo_label:  'Commentaire obligatoire',
    min_deposit: 0.1,
    network:     'TON',
    note:        'Inclure le commentaire/memo pour que le dépôt soit crédité automatiquement.',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/webhook/deposit
// Appelé par toncenter.com quand une tx arrive sur le wallet admin
// Body : { secret, tx_hash, from_address, amount_ton, comment }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook/deposit', async (req, res) => {
  const { secret, tx_hash, from_address, amount_ton, comment } = req.body;

  // Vérifier le secret
  if (secret !== WEBHOOK_SECRET) {
    console.warn('[Webhook] Secret invalide');
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!tx_hash || !amount_ton || amount_ton <= 0) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  const db = getDb();

  // Anti-doublon : vérifier que ce tx_hash n'a pas déjà été traité
  const existing = db.prepare(
    "SELECT id FROM transactions WHERE label LIKE ? LIMIT 1"
  ).get(`%${tx_hash.slice(0, 20)}%`);

  if (existing) {
    console.log('[Webhook] tx déjà traitée:', tx_hash);
    return res.json({ ok: true, duplicate: true });
  }

  // Identifier le joueur via le commentaire (telegram_id ou user_id partiel)
  let user = null;
  if (comment) {
    user = db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(comment.trim())
        || db.prepare("SELECT id FROM users WHERE id LIKE ?").get(comment.trim() + '%');
  }

  if (!user) {
    // Dépôt sans identifiant reconnu → log pour traitement manuel
    console.warn('[Webhook] Dépôt non identifié:', { tx_hash, from_address, amount_ton, comment });
    return res.json({ ok: false, reason: 'Joueur non identifié - traitement manuel requis' });
  }

  // Créditer le compte in-game
  db.transaction(() => {
    db.prepare(
      'UPDATE game_state SET ton = ton + ?, updated_at = unixepoch() WHERE user_id = ?'
    ).run(amount_ton, user.id);

    db.prepare(`
      UPDATE wallets SET balance = balance + ?, updated_at = unixepoch()
      WHERE user_id = ? AND currency = 'TON'
    `).run(amount_ton, user.id);

    db.prepare(`
      INSERT INTO transactions (user_id, label, amount, currency, icon)
      VALUES (?, ?, ?, 'ton', '📥')
    `).run(
      user.id,
      `Dépôt TON (${tx_hash.slice(0, 20)}...)`,
      amount_ton
    );

    // Enregistrer le dépôt
    db.prepare(`
      INSERT OR IGNORE INTO deposits (id, user_id, tx_hash, from_address, amount, currency, status)
      VALUES (?, ?, ?, ?, ?, 'TON', 'confirmed')
    `).run(uuidv4(), user.id, tx_hash, from_address || '', amount_ton);
  })();

  console.log(`[Webhook] Dépôt crédité: ${amount_ton} TON → user ${user.id}`);
  res.json({ ok: true, credited: amount_ton });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/withdraw
// Le joueur demande un retrait → débit in-game immédiat + tx TON automatique
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

  // Validation montant minimum
  const minAmount = cur === 'TON' ? MIN_WITHDRAW_TON : MIN_WITHDRAW_MYCO;
  if (amount < minAmount) {
    return res.status(400).json({ error: `Montant minimum: ${minAmount} ${cur}` });
  }

  // Validation adresse TON
  if (!to_address.match(/^[UE]Q[A-Za-z0-9_\-]{46}$/)) {
    return res.status(400).json({ error: 'Adresse TON invalide' });
  }

  // Vérifier solde
  const gs = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  if (!gs) return res.status(404).json({ error: 'Partie introuvable' });

  const available = cur === 'TON' ? gs.ton : gs.myco;
  if (available < amount) {
    return res.status(400).json({
      error: `Solde insuffisant (${available.toFixed(2)} ${cur} disponible)`
    });
  }

  const reqId = uuidv4();
  let txHash  = null;
  let autoSent = false;

  // ── Tenter l'envoi automatique si c'est du TON ───────────────────────────
  if (cur === 'TON' && TONCENTER_API_KEY && ADMIN_WALLET) {
    try {
      txHash   = await sendTonTransaction(to_address, amount);
      autoSent = !!txHash;
    } catch(e) {
      console.error('[Withdraw] Erreur tx automatique:', e.message);
      // On continue manuellement si l'envoi auto échoue
    }
  }

  // ── Débiter le compte et enregistrer la demande ───────────────────────────
  db.transaction(() => {
    if (cur === 'TON') {
      db.prepare(
        'UPDATE game_state SET ton = ton - ?, updated_at = unixepoch() WHERE user_id = ?'
      ).run(amount, uid);
      db.prepare(
        `UPDATE wallets SET balance = balance - ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'TON'`
      ).run(amount, uid);
    } else {
      db.prepare(
        'UPDATE game_state SET myco = myco - ?, updated_at = unixepoch() WHERE user_id = ?'
      ).run(amount, uid);
      db.prepare(
        `UPDATE wallets SET balance = balance - ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'MYCO'`
      ).run(amount, uid);
    }

    const status = autoSent ? 'completed' : 'pending';

    db.prepare(`
      INSERT INTO withdraw_requests (id, user_id, currency, amount, to_address, status, tx_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(reqId, uid, cur, amount, to_address, status, txHash);

    db.prepare(`
      INSERT INTO transactions (user_id, label, amount, currency, icon)
      VALUES (?, ?, ?, ?, '📤')
    `).run(
      uid,
      `Retrait ${cur}${txHash ? ' (' + txHash.slice(0, 12) + '...)' : ' (en attente)'}`,
      -amount,
      cur.toLowerCase()
    );
  })();

  res.json({
    ok:         true,
    request_id: reqId,
    status:     autoSent ? 'completed' : 'pending',
    tx_hash:    txHash,
    message:    autoSent
      ? `✅ ${amount} ${cur} envoyés ! Tx: ${txHash?.slice(0, 16)}...`
      : `⏳ Retrait de ${amount} ${cur} en attente de traitement (24-48h).`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Envoi automatique d'une transaction TON via toncenter
// ─────────────────────────────────────────────────────────────────────────────
async function sendTonTransaction(toAddress, amountTon) {
  // Note : nécessite un wallet admin avec clé privée
  // En production utiliser @ton/ton SDK avec la clé privée en variable d'env
  // Ici on appelle l'API toncenter /sendBoc avec un message signé

  // Pour l'instant : on retourne null (mode manuel)
  // TODO: intégrer @ton/ton pour signature automatique
  console.log(`[Withdraw] Envoi ${amountTon} TON → ${toAddress} (auto-tx non encore configuré)`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet/deposits
// Historique des dépôts du joueur
// ─────────────────────────────────────────────────────────────────────────────
router.get('/deposits', (req, res) => {
  const db = getDb();
  let deposits = [];
  try {
    deposits = db.prepare(`
      SELECT * FROM deposits WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 20
    `).all(req.userId);
  } catch(e) {
    // Table peut ne pas exister encore
  }
  res.json(deposits);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet  — soldes du joueur
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db  = getDb();
  const uid = req.userId;

  const gs      = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  const wallets = db.prepare('SELECT * FROM wallets WHERE user_id = ?').all(uid);
  const user    = db.prepare('SELECT address, telegram_id FROM users WHERE id = ?').get(uid);

  res.json({
    address:    user?.address,
    game_myco:  gs?.myco  || 0,
    game_ton:   gs?.ton   || 0,
    wallets,
    deposit_address: ADMIN_WALLET || null,
    deposit_memo:    user?.telegram_id || uid.slice(0, 8),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/exchange  — échange MYCO ↔ TON in-game
// ─────────────────────────────────────────────────────────────────────────────
router.post('/exchange', (req, res) => {
  const db  = getDb();
  const uid = req.userId;
  const { direction, amount } = req.body;

  if (!direction || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }

  const RATES = {
    ton_to_myco: { from: 'ton',  to: 'myco', rate: 1000  },
    myco_to_ton: { from: 'myco', to: 'ton',  rate: 0.001 },
  };

  const exch = RATES[direction];
  if (!exch) return res.status(400).json({ error: 'Direction inconnue' });

  const gs = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  if (!gs) return res.status(404).json({ error: 'Partie introuvable' });

  const fromBal = exch.from === 'ton' ? gs.ton : gs.myco;
  if (fromBal < amount) {
    return res.status(400).json({ error: `Solde insuffisant en ${exch.from.toUpperCase()}` });
  }

  const gained = amount * exch.rate;

  db.transaction(() => {
    if (exch.from === 'ton') {
      db.prepare('UPDATE game_state SET ton = ton - ?, myco = myco + ?, updated_at = unixepoch() WHERE user_id = ?')
        .run(amount, gained, uid);
    } else {
      db.prepare('UPDATE game_state SET myco = myco - ?, ton = ton + ?, updated_at = unixepoch() WHERE user_id = ?')
        .run(amount, gained, uid);
    }
    db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,?,'🔄')`)
      .run(uid, `Échange ${exch.from.toUpperCase()} → ${exch.to.toUpperCase()}`, gained, exch.to);
  })();

  const updated = db.prepare('SELECT myco, ton FROM game_state WHERE user_id = ?').get(uid);
  res.json({ ok: true, gained, new_myco: updated.myco, new_ton: updated.ton });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet/withdraw  — historique retraits
// ─────────────────────────────────────────────────────────────────────────────
router.get('/withdraw', (req, res) => {
  const db = getDb();
  const requests = db.prepare(`
    SELECT * FROM withdraw_requests WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 20
  `).all(req.userId);
  res.json(requests);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/ton-address  — sauvegarder adresse TON wallet externe
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ton-address', (req, res) => {
  const db  = getDb();
  const { ton_wallet_address } = req.body;
  if (!ton_wallet_address) return res.status(400).json({ error: 'Adresse manquante' });
  db.prepare('UPDATE users SET address = ? WHERE id = ?').run(ton_wallet_address, req.userId);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — traitement manuel d'un retrait
// ─────────────────────────────────────────────────────────────────────────────
router.post('/admin/withdraw/:id/process', adminMiddleware, (req, res) => {
  const db  = getDb();
  const { status, tx_hash, note } = req.body;

  const request = db.prepare('SELECT * FROM withdraw_requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Demande introuvable' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Déjà traitée' });

  db.transaction(() => {
    db.prepare(`
      UPDATE withdraw_requests
      SET status = ?, tx_hash = ?, note = ?, processed_at = unixepoch()
      WHERE id = ?
    `).run(status, tx_hash || null, note || null, request.id);

    if (status === 'rejected') {
      // Rembourser
      if (request.currency === 'TON') {
        db.prepare('UPDATE game_state SET ton = ton + ?, updated_at = unixepoch() WHERE user_id = ?')
          .run(request.amount, request.user_id);
      } else {
        db.prepare('UPDATE game_state SET myco = myco + ?, updated_at = unixepoch() WHERE user_id = ?')
          .run(request.amount, request.user_id);
      }
      db.prepare(`INSERT INTO transactions (user_id, label, amount, currency, icon) VALUES (?,?,?,?,'↩️')`)
        .run(request.user_id, `Retrait ${request.currency} rejeté - remboursé`, request.amount, request.currency.toLowerCase());
    }
  })();

  res.json({ ok: true, status });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — liste des retraits en attente
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/withdraw/pending', adminMiddleware, (req, res) => {
  const db = getDb();
  const pending = db.prepare(`
    SELECT wr.*, u.username, u.telegram_id FROM withdraw_requests wr
    JOIN users u ON u.id = wr.user_id
    WHERE wr.status = 'pending'
    ORDER BY wr.created_at ASC
  `).all();
  res.json(pending);
});

module.exports = router;
