/**
 * middleware/auth.js
 * Middleware d'authentification unique
 *
 * Utilisation :
 *   const { requireAuth, requireAdmin } = require('../middleware/auth');
 *
 *   router.get('/ma-route', requireAuth, handler)
 *   router.get('/admin-route', requireAuth, requireAdmin, handler)
 */

const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * requireAuth
 * Verifie que le token JWT est valide et que l'utilisateur existe en base.
 * Attache l'utilisateur a req.user.
 */
const requireAuth = async (req, res, next) => {
  // 1. Header Authorization en priorité (token explicite du client)
  const authHeader = req.headers['authorization'];
  const fromHeader = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : null;
  let token = (fromHeader && fromHeader !== 'null' && fromHeader !== 'undefined')
    ? fromHeader
    : null;

  // 2. Fallback : cookie httpOnly (Safari / sessions sans localStorage)
  if (!token) {
    token = req.cookies?.token || null;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentification requise' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        pseudo: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        isAdmin: true,
        registrationStep: true,
        tokenVersion: true,
        profile: {
          select: { id: true, avatar: true, banner: true },
        },
      },
    });

    if (!user) {
      return res.status(401).json({ error: 'Utilisateur introuvable' });
    }

    // Vérifier tokenVersion — si l'utilisateur a invalidé ses sessions (reject-device)
    // les anciens tokens (sans tokenVersion) sont acceptés pour la rétrocompatibilité
    if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
      return res.status(401).json({ error: 'Session expirée, veuillez vous reconnecter' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expiree, veuillez vous reconnecter' });
    }
    return res.status(401).json({ error: 'Token invalide' });
  }
};

/**
 * requireAdmin
 * A utiliser APRES requireAuth.
 * Verifie que l'utilisateur a le role ADMIN ou isAdmin=true.
 */
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentification requise' });
  }

  const isAdmin = req.user.role === 'ADMIN' || req.user.isAdmin === true;

  if (!isAdmin) {
    return res.status(403).json({ error: 'Acces reserve aux administrateurs' });
  }

  next();
};

module.exports = { requireAuth, requireAdmin };
