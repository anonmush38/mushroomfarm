// ton/tonClient.js
// Intégration blockchain TON — solde, jetton MYCO, envoi de transactions
// Utilise @ton/ton SDK + toncenter API comme fallback

const { TonClient, WalletContractV4, internal, toNano, fromNano, Address, JettonMaster, JettonWallet } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';
const ADMIN_MNEMONIC    = (process.env.ADMIN_TON_MNEMONIC || '').split(' ').filter(Boolean);
const MYCO_CONTRACT     = process.env.MYCO_CONTRACT_ADDR || 'EQAxb-16OH8tMGDst_e1M1BFaVpyPSXr3dp0rGQfFZpgEw8a';
const IS_MAINNET        = process.env.TON_NETWORK !== 'testnet';

const TONCENTER_BASE = IS_MAINNET
  ? 'https://toncenter.com/api/v2'
  : 'https://testnet.toncenter.com/api/v2';

const TONAPI_BASE = IS_MAINNET
  ? 'https://tonapi.io/v2'
  : 'https://testnet.tonapi.io/v2';

// ── Client TON (SDK) ──────────────────────────────────────────────────────────
let _client = null;

function getTonClient() {
  if (!_client) {
    _client = new TonClient({
      endpoint: IS_MAINNET
        ? 'https://toncenter.com/api/v2/jsonRPC'
        : 'https://testnet.toncenter.com/api/v2/jsonRPC',
      apiKey: TONCENTER_API_KEY || undefined,
    });
  }
  return _client;
}

// ── Headers API ───────────────────────────────────────────────────────────────
function apiHeaders() {
  const h = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
  if (TONCENTER_API_KEY) h['X-API-Key'] = TONCENTER_API_KEY;
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// Récupérer le solde TON d'une adresse (nanoTON → TON)
// ─────────────────────────────────────────────────────────────────────────────
async function getTonBalance(address) {
  if (!address) return null;

  // Méthode 1 : toncenter v2
  try {
    const r = await fetch(
      `${TONCENTER_BASE}/getAddressBalance?address=${encodeURIComponent(address)}`,
      { headers: apiHeaders() }
    );
    if (r.ok) {
      const d = await r.json();
      if (d.ok && d.result !== undefined) {
        return parseFloat(fromNano(d.result));
      }
    }
  } catch(e) { console.warn('[TON] toncenter balance:', e.message); }

  // Méthode 2 : tonapi.io
  try {
    const r = await fetch(`${TONAPI_BASE}/accounts/${encodeURIComponent(address)}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (r.ok) {
      const d = await r.json();
      if (d.balance !== undefined) {
        return parseFloat(fromNano(String(d.balance)));
      }
    }
  } catch(e) { console.warn('[TON] tonapi balance:', e.message); }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Récupérer le solde MYCO (jetton) d'une adresse
// ─────────────────────────────────────────────────────────────────────────────
async function getMycoBalance(walletAddress) {
  if (!walletAddress || !MYCO_CONTRACT) return null;

  try {
    const r = await fetch(
      `${TONAPI_BASE}/accounts/${encodeURIComponent(walletAddress)}/jettons`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.balances) return null;

    const myco = data.balances.find(j =>
      j.jetton?.address === MYCO_CONTRACT ||
      (j.jetton?.symbol || '').toUpperCase() === 'MYCO'
    );

    if (myco) {
      // Les jettons ont généralement 9 décimales comme TON
      const decimals = myco.jetton?.decimals || 9;
      return parseFloat(myco.balance) / Math.pow(10, decimals);
    }
  } catch(e) { console.warn('[MYCO] getMycoBalance:', e.message); }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Envoyer des TON depuis le wallet admin vers une adresse
// Nécessite ADMIN_TON_MNEMONIC dans les variables d'env
// ─────────────────────────────────────────────────────────────────────────────
async function sendTon(toAddress, amountTon, comment = '') {
  if (!ADMIN_MNEMONIC.length) {
    throw new Error('ADMIN_TON_MNEMONIC non configuré');
  }

  try {
    const client   = getTonClient();
    const keyPair  = await mnemonicToPrivateKey(ADMIN_MNEMONIC);
    const wallet   = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    const contract = client.open(wallet);

    const seqno = await contract.getSeqno();

    await contract.sendTransfer({
      secretKey:   keyPair.secretKey,
      seqno,
      messages: [
        internal({
          to:    Address.parse(toAddress),
          value: toNano(amountTon.toString()),
          body:  comment || undefined,
        }),
      ],
    });

    // Attendre confirmation (max 30s)
    let confirmed = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const newSeqno = await contract.getSeqno();
      if (newSeqno > seqno) { confirmed = true; break; }
    }

    if (!confirmed) throw new Error('Transaction non confirmée dans les délais');

    console.log(`[TON] Envoi ${amountTon} TON → ${toAddress} OK`);
    return { success: true, seqno };

  } catch(e) {
    console.error('[TON] sendTon error:', e.message);
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vérifier les transactions entrantes sur le wallet admin
// Retourne les tx depuis un timestamp donné
// ─────────────────────────────────────────────────────────────────────────────
async function getIncomingTransactions(adminAddress, sinceTimestamp = 0) {
  if (!adminAddress) return [];

  try {
    const r = await fetch(
      `${TONAPI_BASE}/accounts/${encodeURIComponent(adminAddress)}/transactions?limit=50`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!r.ok) return [];
    const data = await r.json();

    return (data.transactions || [])
      .filter(tx => {
        const ts = tx.utime || 0;
        if (ts < sinceTimestamp) return false;
        // Seulement les transactions entrantes (in_msg existe et a de la valeur)
        return tx.in_msg?.value > 0;
      })
      .map(tx => ({
        hash:         tx.hash,
        timestamp:    tx.utime,
        from_address: tx.in_msg?.source?.address || '',
        amount_ton:   parseFloat(fromNano(String(tx.in_msg?.value || 0))),
        comment:      tx.in_msg?.decoded_body?.text || tx.in_msg?.msg_data?.text || '',
      }));
  } catch(e) {
    console.warn('[TON] getIncomingTransactions:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Récupérer l'adresse du wallet admin depuis le mnemonic
// ─────────────────────────────────────────────────────────────────────────────
async function getAdminWalletAddress() {
  if (!ADMIN_MNEMONIC.length) return process.env.ADMIN_TON_WALLET || null;
  try {
    const keyPair = await mnemonicToPrivateKey(ADMIN_MNEMONIC);
    const wallet  = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    return wallet.address.toString({ urlSafe: true, bounceable: false });
  } catch(e) {
    return process.env.ADMIN_TON_WALLET || null;
  }
}

module.exports = {
  getTonBalance,
  getMycoBalance,
  sendTon,
  getIncomingTransactions,
  getAdminWalletAddress,
  MYCO_CONTRACT,
};
