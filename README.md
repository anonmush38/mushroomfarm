# 🍄 Mushroom Farm — Backend API

Backend complet pour le jeu **Mushroom Farm** : sauvegarde des progressions, gestion des utilisateurs et portefeuille crypto (MYCO / TON).

---

## 🗂️ Structure

```
mushroom-backend/
├── src/
│   ├── server.js              ← Point d'entrée Express
│   ├── db/
│   │   └── database.js        ← Schéma SQLite + init
│   ├── middleware/
│   │   └── auth.js            ← JWT + Admin guard
│   └── routes/
│       ├── auth.js            ← Inscription / Connexion / Telegram
│       ├── game.js            ← Sauvegarde progression complète
│       ├── wallet.js          ← Portefeuille crypto + retraits
│       └── cards.js           ← Gestion des cartes champignon
├── mushroom-api-client.js     ← Module JS à intégrer dans le HTML
├── .env.example               ← Variables d'environnement
└── package.json
```

---

## 🚀 Installation

```bash
cd mushroom-backend
npm install
cp .env.example .env       # Édite les variables selon ton env
npm run dev                # Démarrage avec rechargement automatique
# ou
npm start                  # Production
```

---

## ⚙️ Variables d'environnement (.env)

| Variable | Description | Défaut |
|---|---|---|
| `PORT` | Port du serveur | `3000` |
| `JWT_SECRET` | Clé secrète JWT **(changer en prod !)** | — |
| `JWT_EXPIRES_IN` | Durée du token | `30d` |
| `DB_PATH` | Chemin base SQLite | `./data/mushroom_farm.db` |
| `CORS_ORIGINS` | Origines autorisées (virgule) | — |
| `MIN_WITHDRAW_TON` | Retrait minimum TON | `0.1` |
| `MIN_WITHDRAW_MYCO` | Retrait minimum MYCO | `100` |
| `ADMIN_KEY` | Clé admin pour les routes protégées | — |

---

## 📡 Routes API

### 🔐 Auth — `/auth`

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/auth/register` | Créer un compte (`username`, `password?`, `lang`, `theme`, `referral_code?`) |
| `POST` | `/auth/login` | Se connecter (`username`, `password?`) |
| `POST` | `/auth/telegram` | Auto-login Telegram Mini App (`telegram_id`, `username?`, `lang?`) |
| `GET`  | `/auth/me` | Profil utilisateur (🔒 Auth) |

**Exemple register :**
```json
POST /auth/register
{ "username": "MonFarmer", "lang": "fr", "theme": "dark" }
→ { "token": "eyJ...", "userId": "uuid", "username": "MonFarmer", "address": "UQA..." }
```

---

### 🎮 Game — `/game` (🔒 Auth requis)

| Méthode | Route | Description |
|---|---|---|
| `GET`  | `/game/state` | Charger la partie complète |
| `POST` | `/game/state` | Sauvegarder l'état complet |
| `POST` | `/game/harvest` | Sync récolte (`slot_indices`, `mushrooms_gained`, `basket_delta`) |
| `POST` | `/game/transaction` | Ajouter une transaction (`label`, `amount`, `currency`, `icon?`) |
| `GET`  | `/game/transactions` | Historique des transactions (`?limit=50&offset=0`) |
| `POST` | `/game/reward` | Enregistrer une récompense (`type`, `reward`) |
| `GET`  | `/game/leaderboard` | Top 50 des fermiers (total récolté) |

---

### 💰 Wallet — `/wallet` (🔒 Auth requis)

| Méthode | Route | Description |
|---|---|---|
| `GET`  | `/wallet` | Soldes MYCO & TON |
| `POST` | `/wallet/exchange` | Échanger MYCO ↔ TON (`direction`, `amount`) |
| `POST` | `/wallet/withdraw` | Demander un retrait (`currency`, `amount`, `to_address`) |
| `GET`  | `/wallet/withdraw` | Historique des retraits |
| `GET`  | `/wallet/withdraw/:id` | Détail d'un retrait |
| `POST` | `/wallet/deposit` | Simuler un dépôt (`currency`, `amount`) |

**Routes Admin** (header `X-Admin-Key` requis) :
| `GET`  | `/wallet/admin/withdraw/pending` | Liste des retraits en attente |
| `POST` | `/wallet/admin/withdraw/:id/process` | Valider/Rejeter un retrait (`status`, `tx_hash?`) |

---

### 🃏 Cards — `/cards` (🔒 Auth requis)

| Méthode | Route | Description |
|---|---|---|
| `GET`  | `/cards` | Liste toutes les cartes |
| `POST` | `/cards/buy` | Acheter une carte (`rarity`) |
| `POST` | `/cards/:id/upgrade` | Upgrader une carte |
| `POST` | `/cards/merge` | Fusionner 2 cartes (`base_id`, `sacrifice_id`) |
| `POST` | `/cards/:id/sell` | Vendre une carte contre des champignons |
| `POST` | `/cards/:id/deploy` | Déployer sur un slot (`slot_index`) |
| `POST` | `/cards/:id/retire` | Retirer du slot |

---

## 🌐 Intégration dans le jeu HTML

1. **Copie** `mushroom-api-client.js` dans le même dossier que le jeu.
2. **Ajoute** dans `mushroom-farm.html`, juste avant `</body>` :

```html
<script src="mushroom-api-client.js"></script>
```

3. Le client s'initialise automatiquement et active :
   - **Connexion automatique** à l'inscription (`startGame`)
   - **Sauvegarde cloud** toutes les 30 secondes
   - **Fallback local** si le serveur est inaccessible

### Option Telegram Mini App

Pour déployer comme Telegram Mini App :
```javascript
// Dans ton Telegram WebApp
const user = window.Telegram?.WebApp?.initDataUnsafe?.user;
if (user) {
  await MushroomAPI.telegramLogin(user.id, user.username, 'fr');
}
```

---

## 🗄️ Base de données (SQLite)

Tables créées automatiquement au démarrage :

| Table | Contenu |
|---|---|
| `users` | Comptes joueurs (username, adresse, Telegram ID) |
| `game_state` | État complet par joueur (MYCO, TON, timestamps) |
| `cards` | Toutes les cartes (rareté, niveau, XP, déploiement) |
| `farm_slots` | État des 50 slots de farm |
| `unlocked_slots` | Slots déverrouillés (au-delà des 5 gratuits) |
| `basket` | Champignons récoltés par rareté |
| `transactions` | Historique des transactions |
| `reward_history` | Historique des récompenses (spins, cadeaux) |
| `wallets` | Portefeuilles MYCO & TON par joueur |
| `withdraw_requests` | Demandes de retrait crypto |
| `referrals` | Système de parrainage |

---

## 🔒 Sécurité

- Authentification **JWT** avec expiration configurable
- Mots de passe hashés avec **bcryptjs** (salt rounds = 10)
- Clé admin séparée pour les routes d'administration
- Validation des adresses TON avant retrait
- Verrouillage des fonds en attente de retrait
- Remboursement automatique en cas de retrait rejeté

---

## 🚀 Déploiement (Production)

```bash
# Sur un VPS (Ubuntu/Debian)
npm install --production
NODE_ENV=production JWT_SECRET=<strong_secret> npm start

# Avec PM2 (recommandé)
npm install -g pm2
pm2 start src/server.js --name mushroom-farm
pm2 save

# Avec reverse proxy Nginx
# Pointer /api vers http://localhost:3000
```
