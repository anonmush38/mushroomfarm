// server.js
require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const authRoutes   = require('./routes/auth');
const gameRoutes   = require('./routes/game');
const walletRoutes = require('./routes/wallet');
const cardRoutes   = require('./routes/cards');
const { getDb }    = require('./db/database');
const { startDepositPoller } = require('./ton/depositPoller');

getDb(); // Init DB

const app  = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} non autorisé`));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Admin-Key'],
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok', version: '2.0.0', time: new Date().toISOString() }));

app.use('/auth',   authRoutes);
app.use('/game',   gameRoutes);
app.use('/wallet', walletRoutes);
app.use('/cards',  cardRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Route inconnue' }));
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
});

app.listen(PORT, () => {
  console.log(`\n🍄 Mushroom Farm API sur http://localhost:${PORT}`);
  console.log(`   Réseau TON: ${process.env.TON_NETWORK || 'mainnet'}`);

  // Démarrer le polling des dépôts TON
  if (process.env.ADMIN_TON_WALLET || process.env.ADMIN_TON_MNEMONIC) {
    startDepositPoller();
  } else {
    console.warn('⚠️  ADMIN_TON_WALLET non configuré — polling dépôts désactivé');
  }
});

module.exports = app;
