// ton/depositPoller.js
// Vérifie automatiquement les transactions entrantes sur le wallet admin
// et crédite les joueurs en conséquence — fonctionne sans webhook externe

const { getIncomingTransactions, getAdminWalletAddress } = require('./tonClient');
const { getDb } = require('../db/database');
const { v4: uuidv4 } = require('uuid');

const POLL_INTERVAL_MS = 30000; // vérifier toutes les 30 secondes
const MIN_DEPOSIT_TON  = parseFloat(process.env.MIN_DEPOSIT_TON || '0.1');

let _lastCheckedAt = Math.floor(Date.now() / 1000) - 300; // 5 min en arrière au démarrage
let _polling = false;

// ─────────────────────────────────────────────────────────────────────────────
// Traiter une transaction entrante et créditer le bon joueur
// ─────────────────────────────────────────────────────────────────────────────
async function processDeposit(tx) {
  const db = getDb();

  // Anti-doublon
  const existing = db.prepare('SELECT id FROM deposits WHERE tx_hash = ?').get(tx.hash);
  if (existing) return;

  if (tx.amount_ton < MIN_DEPOSIT_TON) {
    console.log(`[Deposit] Montant trop faible (${tx.amount_ton} TON), ignoré`);
    return;
  }

  // Identifier le joueur via le commentaire (telegram_id)
  let user = null;
  const comment = (tx.comment || '').trim();

  if (comment) {
    user = db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(comment)
        || db.prepare("SELECT id FROM users WHERE id LIKE ?").get(comment + '%');
  }

  if (!user) {
    // Essayer via l'adresse source
    user = db.prepare('SELECT id FROM users WHERE address = ?').get(tx.from_address);
  }

  if (!user) {
    console.warn(`[Deposit] Joueur non identifié pour tx ${tx.hash} (comment: "${comment}")`);
    // Enregistrer quand même pour traitement manuel
    db.prepare(`
      INSERT OR IGNORE INTO deposits (id, user_id, tx_hash, from_address, amount, currency, status)
      VALUES (?, 'UNKNOWN', ?, ?, ?, 'TON', 'unmatched')
    `).run(uuidv4(), tx.hash, tx.from_address, tx.amount_ton);
    return;
  }

  // Créditer le compte in-game
  db.transaction(() => {
    db.prepare(
      'UPDATE game_state SET ton = ton + ?, updated_at = unixepoch() WHERE user_id = ?'
    ).run(tx.amount_ton, user.id);

    db.prepare(
      `UPDATE wallets SET balance = balance + ?, updated_at = unixepoch() WHERE user_id = ? AND currency = 'TON'`
    ).run(tx.amount_ton, user.id);

    db.prepare(`
      INSERT INTO transactions (user_id, label, amount, currency, icon)
      VALUES (?, ?, ?, 'ton', '📥')
    `).run(user.id, `Dépôt TON on-chain (${tx.hash.slice(0, 12)}...)`, tx.amount_ton);

    db.prepare(`
      INSERT OR IGNORE INTO deposits (id, user_id, tx_hash, from_address, amount, currency, status)
      VALUES (?, ?, ?, ?, ?, 'TON', 'confirmed')
    `).run(uuidv4(), user.id, tx.hash, tx.from_address, tx.amount_ton);
  })();

  console.log(`[Deposit] ✅ ${tx.amount_ton} TON crédité → user ${user.id} (tx: ${tx.hash.slice(0, 16)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Boucle de polling
// ─────────────────────────────────────────────────────────────────────────────
async function pollDeposits() {
  if (_polling) return;
  _polling = true;

  try {
    const adminAddr = await getAdminWalletAddress();
    if (!adminAddr) {
      console.warn('[Deposit] Adresse admin non configurée — polling désactivé');
      return;
    }

    const txs = await getIncomingTransactions(adminAddr, _lastCheckedAt);

    if (txs.length > 0) {
      console.log(`[Deposit] ${txs.length} nouvelle(s) tx détectée(s)`);
      for (const tx of txs) {
        await processDeposit(tx);
      }
    }

    _lastCheckedAt = Math.floor(Date.now() / 1000);
  } catch(e) {
    console.error('[Deposit] Erreur polling:', e.message);
  } finally {
    _polling = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Démarrer le polling automatique
// ─────────────────────────────────────────────────────────────────────────────
function startDepositPoller() {
  console.log(`[Deposit] Polling démarré (intervalle: ${POLL_INTERVAL_MS / 1000}s)`);
  pollDeposits(); // premier check immédiat
  return setInterval(pollDeposits, POLL_INTERVAL_MS);
}

module.exports = { startDepositPoller, pollDeposits };
