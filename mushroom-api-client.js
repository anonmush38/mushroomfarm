// ============================================================
// mushroom-api-client.js
// Module d'intégration API à inclure dans mushroom-farm.html
// ============================================================
// Ajoute ce fichier via : <script src="mushroom-api-client.js"></script>
// Ou copie directement dans la balise <script> du HTML
// ============================================================

const MushroomAPI = (() => {

  // === CONFIGURATION ===
  const BASE_URL = 'http://localhost:3000'; // Change en production
  let _token = null;
  let _autoSaveInterval = null;
  const AUTO_SAVE_MS = 30_000; // Sauvegarde automatique toutes les 30s

  // === STORAGE LOCAL (fallback si offline) ===
  function localSave(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
  }
  function localLoad(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }

  // === TOKEN ===
  function setToken(t) {
    _token = t;
    localSave('mf_token', t);
  }
  function loadToken() {
    _token = localLoad('mf_token');
    return _token;
  }

  // === HTTP HELPER ===
  async function req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (_token) headers['Authorization'] = `Bearer ${_token}`;
    try {
      const res = await fetch(BASE_URL + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      console.warn(`[API] ${method} ${path} →`, err.message);
      throw err;
    }
  }

  // ============================================================
  // AUTH
  // ============================================================

  async function register(username, options = {}) {
    const data = await req('POST', '/auth/register', {
      username,
      password: options.password,
      lang: options.lang || 'fr',
      theme: options.theme || 'dark',
      referral_code: options.referral_code,
    });
    setToken(data.token);
    localSave('mf_userId', data.userId);
    localSave('mf_username', data.username);
    return data;
  }

  async function login(username, password) {
    const data = await req('POST', '/auth/login', { username, password });
    setToken(data.token);
    localSave('mf_userId', data.userId);
    localSave('mf_username', data.username);
    return data;
  }

  async function telegramLogin(telegramId, username, lang) {
    const data = await req('POST', '/auth/telegram', { telegram_id: telegramId, username, lang });
    setToken(data.token);
    localSave('mf_userId', data.userId);
    return data;
  }

  function logout() {
    _token = null;
    stopAutoSave();
    ['mf_token','mf_userId','mf_username'].forEach(k => localStorage.removeItem(k));
  }

  function isLoggedIn() { return !!_token; }

  // ============================================================
  // GAME STATE
  // ============================================================

  async function loadState() {
    try {
      return await req('GET', '/game/state');
    } catch {
      // Fallback: load from localStorage
      return localLoad('mf_game_state');
    }
  }

  async function saveState(gameState) {
    localSave('mf_game_state', gameState); // Always save locally first
    try {
      return await req('POST', '/game/state', gameState);
    } catch (err) {
      console.warn('[API] Sauvegarde cloud échouée, état conservé en local', err.message);
      return { ok: false, local_only: true };
    }
  }

  async function saveHarvest(slotIndices, mushroomsGained, basketDelta) {
    try {
      return await req('POST', '/game/harvest', {
        slot_indices: slotIndices,
        mushrooms_gained: mushroomsGained,
        basket_delta: basketDelta,
      });
    } catch (err) {
      console.warn('[API] Harvest sync échoué', err.message);
    }
  }

  async function getLeaderboard() {
    return req('GET', '/game/leaderboard');
  }

  // ============================================================
  // WALLET / CRYPTO
  // ============================================================

  async function getWallet() {
    return req('GET', '/wallet');
  }

  async function exchange(direction, amount) {
    // direction: 'ton_to_myco' | 'myco_to_ton'
    return req('POST', '/wallet/exchange', { direction, amount });
  }

  async function requestWithdraw(currency, amount, toAddress) {
    return req('POST', '/wallet/withdraw', { currency, amount, to_address: toAddress });
  }

  async function getWithdrawHistory() {
    return req('GET', '/wallet/withdraw');
  }

  // ============================================================
  // CARDS
  // ============================================================

  async function buyCard(rarity) {
    return req('POST', '/cards/buy', { rarity });
  }

  async function upgradeCard(cardId) {
    return req('POST', `/cards/${cardId}/upgrade`);
  }

  async function mergeCards(baseId, sacrificeId) {
    return req('POST', '/cards/merge', { base_id: baseId, sacrifice_id: sacrificeId });
  }

  async function sellCard(cardId) {
    return req('POST', `/cards/${cardId}/sell`);
  }

  async function deployCard(cardId, slotIndex) {
    return req('POST', `/cards/${cardId}/deploy`, { slot_index: slotIndex });
  }

  async function retireCard(cardId) {
    return req('POST', `/cards/${cardId}/retire`);
  }

  // ============================================================
  // AUTO-SAVE
  // ============================================================

  function startAutoSave(getStateCallback) {
    stopAutoSave();
    _autoSaveInterval = setInterval(async () => {
      if (!_token) return;
      try {
        const currentState = getStateCallback();
        await saveState(currentState);
        console.log('[API] ✅ Sauvegarde automatique OK');
      } catch (err) {
        console.warn('[API] Auto-save échoué', err.message);
      }
    }, AUTO_SAVE_MS);
  }

  function stopAutoSave() {
    if (_autoSaveInterval) {
      clearInterval(_autoSaveInterval);
      _autoSaveInterval = null;
    }
  }

  // ============================================================
  // INIT - à appeler au démarrage du jeu
  // ============================================================
  async function init() {
    loadToken();
    if (_token) {
      try {
        // Verify token is still valid
        await req('GET', '/auth/me');
        return true;
      } catch {
        // Token expired
        logout();
        return false;
      }
    }
    return false;
  }

  // ============================================================
  // INTEGRATION AVEC LE JEU EXISTANT
  // ============================================================
  // Patch des fonctions du jeu pour synchroniser avec l'API

  function patchGameFunctions() {
    // Patch startGame pour register/login
    const origStartGame = window.startGame;
    window.startGame = async function() {
      const username = document.getElementById('username-input').value.trim() || 'Farmer';

      try {
        // Try to login first, register if not found
        let authData;
        try {
          authData = await login(username);
        } catch (err) {
          if (err.message.includes('introuvable')) {
            authData = await register(username, {
              lang: window.currentLang || 'fr',
              theme: window._selectedTheme || 'dark',
            });
          } else throw err;
        }

        // Try to load cloud save
        const cloudState = await loadState();
        if (cloudState && cloudState.player) {
          // Restore state from cloud
          Object.assign(window.state, cloudState);
          console.log('[API] ☁️ Partie chargée depuis le cloud');
        }

        showNotif('☁️ Synchronisé avec le cloud !', '🍄');
      } catch (err) {
        console.warn('[API] Mode hors-ligne, partie locale uniquement', err.message);
        showNotif('📱 Mode hors-ligne activé', '⚠️');
      }

      // Call original function
      origStartGame.call(this);

      // Start auto-save
      startAutoSave(() => window.state);
    };

    // Patch harvestAll pour synchroniser
    const origHarvestAll = window.harvestAll;
    window.harvestAll = async function() {
      origHarvestAll.call(this);
      // Sync harvest asynchronously
      if (isLoggedIn()) {
        setTimeout(() => saveState(window.state), 500);
      }
    };
  }

  // ============================================================
  // PUBLIC API
  // ============================================================
  return {
    init,
    register,
    login,
    telegramLogin,
    logout,
    isLoggedIn,

    loadState,
    saveState,
    saveHarvest,
    getLeaderboard,

    getWallet,
    exchange,
    requestWithdraw,
    getWithdrawHistory,

    buyCard,
    upgradeCard,
    mergeCards,
    sellCard,
    deployCard,
    retireCard,

    startAutoSave,
    stopAutoSave,
    patchGameFunctions,
  };
})();

// Auto-init au chargement
document.addEventListener('DOMContentLoaded', async () => {
  const loggedIn = await MushroomAPI.init();
  if (loggedIn) {
    console.log('[API] ✅ Session restaurée');
  }
  // Patch le jeu si les fonctions sont disponibles
  if (typeof window.startGame === 'function') {
    MushroomAPI.patchGameFunctions();
  }
});
