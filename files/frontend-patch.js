// ============================================================
// PATCH FRONTEND — À intégrer dans index.html
//
// Ce bloc remplace les fonctions suivantes dans index.html :
//   - syncToManager()
//   - loadFromServer()
//   - initTonConnect()
//   - La IIFE checkExistingSave (démarrage)
//
// Placer CE BLOC juste avant la fermeture </script> principale.
// ============================================================

const BASE_URL = 'https://mushroomfarm-majn.onrender.com';

// ── Helpers JWT ───────────────────────────────────────────────────────────────

function getToken() {
  return localStorage.getItem('mf_jwt') || null;
}

function saveToken(token) {
  localStorage.setItem('mf_jwt', token);
}

function clearToken() {
  localStorage.removeItem('mf_jwt');
}

function apiHeaders() {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

// ── Authentification Telegram ─────────────────────────────────────────────────
// Appeler AU DÉMARRAGE. Retourne true si authentifié, false sinon.

async function authenticateWithBackend(tgUser) {
  try {
    const r = await fetch(`${BASE_URL}/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram_id: tgUser.id,
        username:    tgUser.username || tgUser.first_name || null,
        lang:        state.lang || 'fr',
        theme:       state.theme || 'dark',
      }),
    });

    if (!r.ok) return false;
    const data = await r.json();

    if (data.token) {
      saveToken(data.token);
      // Mettre à jour le state avec les infos du profil
      state.player  = data.username || state.player;
      state.address = data.address  || state.address;
      return true;
    }
  } catch (e) {
    console.warn('[Auth] Backend inaccessible:', e.message);
  }
  return false;
}

// ── Chargement état depuis le serveur ─────────────────────────────────────────
// Remplace l'ancien loadFromServer(playerName).
// Retourne true si le state a été chargé, false sinon.

async function loadFromServer() {
  if (!getToken()) return false;
  try {
    const r = await fetch(`${BASE_URL}/game/state`, {
      headers: apiHeaders(),
    });

    if (r.status === 401) {
      // Token expiré ou invalide
      clearToken();
      return false;
    }
    if (!r.ok) return false;

    const data = await r.json();
    if (data && data.myco !== undefined) {
      // Fusionner avec le state local (le serveur est la source de vérité)
      Object.assign(state, {
        player:               data.player               || state.player,
        myco:                 data.myco,
        ton:                  data.ton,
        total_harvested:      data.total_harvested       || 0,
        pending_myco:         data.pending_myco          || 0,
        pending_count:        data.pending_count         || 0,
        exchange_direction:   data.exchange_direction    || 'ton_to_myco',
        last_midnight_reward: data.last_midnight_reward  || null,
        last_free_spin:       data.last_free_spin        || null,
        last_free_slot_spin:  data.last_free_slot_spin   || null,
        last_daily_gift:      data.last_daily_gift       || null,
        slots:                data.slots                 || state.slots,
        wallet_cards:         data.wallet_cards          || state.wallet_cards,
        unlocked_slots:       data.unlocked_slots        || state.unlocked_slots,
        basket:               data.basket                || state.basket,
        transactions:         data.transactions          || state.transactions,
        address:              data.address               || state.address,
      });
      return true;
    }
  } catch (e) {
    console.warn('[Load] Erreur chargement serveur:', e.message);
  }
  return false;
}

// ── Sauvegarde état vers le serveur ──────────────────────────────────────────
// Remplace les anciens appels /api/sync et /api/save.

async function syncToManager() {
  if (!getToken()) return;
  try {
    await fetch(`${BASE_URL}/game/state`, {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify(state),
    });
  } catch (e) {
    console.warn('[Sync] Erreur sauvegarde serveur:', e.message);
  }
}

// ── TonConnect corrigé ────────────────────────────────────────────────────────
// Corrections : manifest via URL hébergée (plus de Blob), persistance adresse réelle.

function initTonConnect() {
  if (typeof TON_CONNECT_UI === 'undefined') return;

  // ✅ URL statique hébergée — remplacer par votre domaine réel
  // Créer le fichier tonconnect-manifest.json à cette URL avec le contenu :
  // { "url": "https://votre-domaine.com", "name": "Mushroom Farm", "iconUrl": "https://votre-domaine.com/icon.png" }
  const MANIFEST_URL = 'https://anonmush38.github.io/mushroomfarm/tonconnect-manifest.json';

  try {
    window.tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
      manifestUrl:  MANIFEST_URL,
      buttonRootId: null,
    });

    window.tonConnectUI.onStatusChange(wallet => {
      if (wallet) {
        // Wallet connecté : récupérer l'adresse réelle
        const realAddress = wallet.account.address;
        state.address     = realAddress;

        // Persister en base via le backend
        fetch(`${BASE_URL}/wallet/ton-address`, {
          method:  'POST',
          headers: apiHeaders(),
          body:    JSON.stringify({ ton_wallet_address: realAddress }),
        }).catch(e => console.warn('[TonConnect] Erreur persistance adresse:', e.message));

        updateUI();
        saveState();

      } else {
        // Wallet déconnecté
        console.log('[TonConnect] Wallet déconnecté');
        updateUI();
      }
    });

  } catch (e) {
    console.warn('[TonConnect] Erreur initialisation:', e.message);
  }
}

// ── Démarrage principal (remplace la IIFE checkExistingSave) ──────────────────
// Logique :
//   1. Lire l'identité Telegram
//   2. Authentifier avec le backend → récupérer JWT
//   3. Si JWT ok → charger l'état depuis le serveur → lancer le jeu DIRECTEMENT
//   4. Sinon → fallback CloudStorage/localStorage → afficher le splash

(async function initGame() {
  const tg     = window.Telegram?.WebApp;
  const tgUser = tg?.initDataUnsafe?.user || null;

  if (tg) {
    tg.ready();
    tg.expand();
  }

  // Afficher le nom Telegram dans le splash pendant le chargement
  if (tgUser) {
    const nameEl = document.getElementById('tg-name-preview');
    if (nameEl) nameEl.textContent = tgUser.first_name || tgUser.username || '';
  }

  await new Promise(r => setTimeout(r, 400));

  // ── Tentative de connexion automatique ─────────────────────────────────
  if (tgUser) {
    const authed = await authenticateWithBackend(tgUser);

    if (authed) {
      const loaded = await loadFromServer();

      if (loaded) {
        // ✅ Connexion auto réussie — bypass du splash
        applyTheme();
        applyLang(state.lang || 'fr');

        const splash = document.getElementById('splash');
        const topbar = document.getElementById('topbar');
        const nav    = document.getElementById('nav');
        if (splash) splash.style.display = 'none';
        if (topbar) topbar.style.display = 'flex';
        if (nav)    nav.style.display    = 'flex';

        showPage('farm');
        if (typeof initFarmGrid   === 'function') initFarmGrid();
        if (typeof initShop       === 'function') initShop();
        if (typeof initBoxes      === 'function') initBoxes();
        if (typeof drawWheel      === 'function') drawWheel();
        updateUI();
        if (typeof startFarmTick     === 'function') startFarmTick();
        if (typeof startMidnightTimer === 'function') startMidnightTimer();
        setTimeout(initTonConnect, 1000);
        startAutoSync();
        return; // ← pas de splash
      }
    }
  }

  // ── Fallback : vérifier un token JWT existant (session précédente) ──────
  if (getToken()) {
    const loaded = await loadFromServer();
    if (loaded) {
      applyTheme();
      applyLang(state.lang || 'fr');

      const splash = document.getElementById('splash');
      const topbar = document.getElementById('topbar');
      const nav    = document.getElementById('nav');
      if (splash) splash.style.display = 'none';
      if (topbar) topbar.style.display = 'flex';
      if (nav)    nav.style.display    = 'flex';

      showPage('farm');
      if (typeof initFarmGrid    === 'function') initFarmGrid();
      if (typeof initShop        === 'function') initShop();
      if (typeof initBoxes       === 'function') initBoxes();
      if (typeof drawWheel       === 'function') drawWheel();
      updateUI();
      if (typeof startFarmTick      === 'function') startFarmTick();
      if (typeof startMidnightTimer === 'function') startMidnightTimer();
      setTimeout(initTonConnect, 1000);
      startAutoSync();
      return;
    }
  }

  // ── Fallback final : afficher le splash normalement ─────────────────────
  // Vérifier si une sauvegarde locale existe pour afficher le bon bouton
  let hasSave = false;
  try {
    if (tg?.CloudStorage) {
      hasSave = await new Promise(resolve => {
        tg.CloudStorage.getItem('hasSave', (err, val) => resolve(!err && val === '1'));
      });
    }
  } catch (_) {}
  if (!hasSave) {
    hasSave = !!localStorage.getItem('mf_save');
  }

  const btnContinue  = document.getElementById('btn-continue');
  const btnRegister  = document.getElementById('btn-register');
  const splash       = document.getElementById('splash');
  if (splash)       splash.style.display = 'flex';
  if (btnContinue)  btnContinue.style.display  = hasSave ? 'block' : 'none';
  if (btnRegister)  btnRegister.style.display  = hasSave ? 'none'  : 'block';

})();
