// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Verify user still exists and is active
    const db = getDb();
    const user = db.prepare('SELECT id, username, is_active FROM users WHERE id = ?').get(payload.userId);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Utilisateur introuvable ou désactivé' });
    }
    req.userId = user.id;
    req.username = user.username;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function adminMiddleware(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  next();
}

module.exports = { authMiddleware, adminMiddleware };
