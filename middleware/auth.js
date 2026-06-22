/**
 * middleware/auth.js
 * Middleware d'authentification unique — remplace les 5 anciens fichiers
 *
 * Utilisation :
 *   const { requireAuth, requireAdmin } = require('../middleware/auth');
 *
 *   router.get('/ma-route', requireAuth, handler)           // utilisateur connecté
 *   router.get('/admin-route', requireAuth, requireAdmin, handler) // admin uniquement
 */

const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * requireAuth
 * Vérifie que le token JWT est valide et que l'utilisateur existe en base.
 * Attache l'utilisateur complet à req.user.
 */
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentification requise ❌' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Vérification en base pour s'assurer que l'utilisateur existe toujours
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isAdmin: true,
        profile: {
          select: { id: true, avatar: true, banner: true },
        },
      },
    });

    if (!user) {
      return res.status(401).json({ error: 'Utilisateur introuvable ❌' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expirée, veuillez vous reconnecter ❌' });
    }
    return res.status(401).json({ error: 'Token invalide ❌' });
  }
};

/**
 * requireAdmin
 * À utiliser APRÈS requireAuth.
 * Vérifie que l'utilisateur a le rôle ADMIN ou isAdmin=true.
 */
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentification requise ❌' });
  }

  const isAdmin = req.user.role === 'ADMIN' || req.user.isAdmin === true;

  if (!isAdmin) {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs ❌' });
  }

  next();
};

module.exports = { requireAuth, requireAdmin };
