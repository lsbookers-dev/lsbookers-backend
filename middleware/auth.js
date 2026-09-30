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
const prisma = require('../prisma/client');

/**
 * authenticate
 * Lit le token (en-tête Authorization puis cookie httpOnly), le vérifie et charge
 * l'utilisateur. Renvoie { user } ou { status, error } — ne répond jamais lui-même.
 */
async function authenticate(req) {
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
    return { status: 401, error: 'Authentification requise' };
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
        emailVerified: true,
        tokenVersion: true,
        profile: {
          select: { id: true, avatar: true, banner: true },
        },
      },
    });

    if (!user) {
      return { status: 401, error: 'Utilisateur introuvable' };
    }

    // Une session normale n'est valable qu'après vérification de l'adresse email.
    if (!user.emailVerified) {
      return { status: 403, error: 'EMAIL_NOT_VERIFIED' };
    }

    // Les jetons hérités sans version sont refusés : toute session doit être révocable.
    if (!Number.isInteger(decoded.tokenVersion) || decoded.tokenVersion !== user.tokenVersion) {
      return { status: 401, error: 'Session expirée, veuillez vous reconnecter' };
    }

    return { user };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return { status: 401, error: 'Session expiree, veuillez vous reconnecter' };
    }
    return { status: 401, error: 'Token invalide' };
  }
}

/**
 * requireAuth
 * Verifie que le token JWT est valide et que l'utilisateur existe en base.
 * Attache l'utilisateur a req.user.
 */
const requireAuth = async (req, res, next) => {
  const result = await authenticate(req);
  if (!result.user) {
    return res.status(result.status).json({ error: result.error });
  }
  req.user = result.user;
  next();
};

/**
 * optionalAuth
 * Pour les routes publiques : attache req.user si le visiteur est connecté,
 * sinon laisse passer sans erreur (req.user reste undefined).
 */
const optionalAuth = async (req, res, next) => {
  const result = await authenticate(req);
  if (result.user) req.user = result.user;
  next();
};

/**
 * isAdminUser — règle UNIQUE « est-ce un admin ? » : le rôle ADMIN.
 * (Le champ isAdmin de la base n'est plus utilisé pour donner des droits.)
 */
const isAdminUser = (user) => !!user && String(user.role || '').toUpperCase() === 'ADMIN';

/**
 * requireAdmin
 * A utiliser APRES requireAuth.
 */
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentification requise' });
  }

  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: 'Acces reserve aux administrateurs' });
  }

  next();
};

module.exports = { requireAuth, optionalAuth, requireAdmin, isAdminUser };
