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
const { touchSession } = require('../lib/sessions');
const { requestedProfileId, findActiveManagement, isBlockedWhileActing } = require('../lib/managedProfiles');
const { hasAgency } = require('../lib/plan');

// Champs chargés pour le compte connecté (et pour le compte d'un profil géré)
const USER_SELECT = {
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
  pausedAt: true,
  bannedAt: true,
  canManageProfiles: true,
  profile: {
    select: { id: true, avatar: true, banner: true },
  },
};

/**
 * Profil géré demandé par l'en-tête X-Act-As-Profile : renvoie le compte du profil
 * si une gestion active le permet, sinon une erreur (le site retire alors la sélection).
 */
async function resolveActing(manager, profileId) {
  if (!(await hasAgency(manager))) return { status: 403, error: 'MANAGEMENT_ENDED' };
  const management = await findActiveManagement(manager.id, profileId);
  if (!management) return { status: 403, error: 'MANAGEMENT_ENDED' };
  const managed = await prisma.user.findUnique({ where: { id: management.profile.userId }, select: USER_SELECT });
  if (!managed || managed.bannedAt || !managed.emailVerified) return { status: 403, error: 'MANAGEMENT_ENDED' };
  return { user: managed, management: { id: management.id, profileId: management.profileId, requireApproval: management.requireApproval } };
}

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
        ...USER_SELECT,
        // Session de l'appareil (jetons émis depuis le 21/10/2026) : refusée si retirée dans les Réglages
        ...(typeof decoded.sid === 'string'
          ? { sessions: { where: { sid: decoded.sid }, select: { id: true, revokedAt: true, lastUsedAt: true }, take: 1 } }
          : {}),
      },
    });

    if (!user) {
      return { status: 401, error: 'Utilisateur introuvable' };
    }

    // Compte suspendu par l'admin
    if (user.bannedAt) {
      return { status: 403, error: 'ACCOUNT_BANNED' };
    }

    // Une session normale n'est valable qu'après vérification de l'adresse email.
    if (!user.emailVerified) {
      return { status: 403, error: 'EMAIL_NOT_VERIFIED' };
    }

    // Les jetons hérités sans version sont refusés : toute session doit être révocable.
    if (!Number.isInteger(decoded.tokenVersion) || decoded.tokenVersion !== user.tokenVersion) {
      return { status: 401, error: 'Session expirée, veuillez vous reconnecter' };
    }

    let sessionSid = null;
    if (typeof decoded.sid === 'string') {
      const session = user.sessions?.[0];
      if (!session || session.revokedAt) {
        return { status: 401, error: 'Session fermée, veuillez vous reconnecter' };
      }
      touchSession(session);
      sessionSid = decoded.sid;
    }
    delete user.sessions;

    // « Vous agissez en tant que » : le compte du profil géré remplace celui de l'agent
    const actAs = requestedProfileId(req);
    if (actAs && actAs !== user.profile?.id) {
      const acting = await resolveActing(user, actAs);
      if (!acting.user) return acting;
      return { user: acting.user, actor: user, management: acting.management, sessionSid };
    }

    return { user, sessionSid };
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
  req.sessionSid = result.sessionSid || null;
  if (result.actor) {
    req.actor = result.actor;
    req.management = result.management;
    // Identifiants, réglages du compte, abonnement, argent : réservés au titulaire
    if (isBlockedWhileActing(req.method, req.originalUrl)) {
      return res.status(403).json({ error: 'MANAGED_FORBIDDEN', message: 'Cette action est réservée au titulaire du compte.' });
    }
  }
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
  if (result.actor) { req.actor = result.actor; req.management = result.management; }
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

module.exports = { requireAuth, optionalAuth, requireAdmin, isAdminUser, authenticate };
