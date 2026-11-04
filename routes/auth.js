const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { memberOrIp } = require('../lib/rateLimitKeys');
const prisma = require('../prisma/client');
const { hidePrivateFromManager, accountName } = require('../lib/managedProfiles');
const { hasAgency } = require('../lib/plan');
const { requireAuth, isAdminUser } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const {
  loginSchema,
  registerCompleteSchema,
  resendVerificationSchema,
  deleteAccountSchema,
} = require('../schemas');
const { deleteUserAccount } = require('../services/accountDeletion');
const emailUtils = require('../utils/email');
const { sendVerificationEmail } = emailUtils;
const { signSecureAccountToken } = require('../lib/secureAccount');
const { issueSession, deviceNameFromUA } = require('../lib/sessions');
const { logAdmin } = require('../lib/adminLog');
const { createNotif } = require('../services/notifications');
const { setSessionCookie, clearSessionCookie, isSameSiteRequest } = require('../lib/session');

// Rate limiting pour les routes publiques d'énumération
const pseudoCheckLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,             // max 20 vérifications par minute par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de vérifications, réessayez dans une minute' },
});

// Vérification SIRET : appelle l'API gouvernementale → limite stricte par IP
const siretCheckLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,             // max 10 vérifications par minute par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { valid: false, error: 'Trop de vérifications, réessayez dans une minute' },
});

// Ne jamais exposer les secrets et compteurs internes du compte au navigateur.
/** Supprime le profil préparé par une agence pour cette adresse si son invitation a expiré */
// Profil créé par une agence, jamais réclamé et dont l'invitation a expiré : son e-mail est libre
async function expiredDraftProfileId(email) {
  const draft = await prisma.user.findUnique({
    where: { email },
    select: { emailVerified: true, profile: { select: { id: true, managers: { select: { origin: true, status: true, expiresAt: true } } } } },
  });
  const managers = draft?.profile?.managers || [];
  if (!draft || draft.emailVerified || !managers.length) return null;
  const stillValid = managers.some(m => m.origin !== 'CREATED' || m.status === 'ACTIVE' || (m.status === 'PENDING' && m.expiresAt && m.expiresAt > new Date()));
  return stillValid ? null : draft.profile.id;
}

async function releaseExpiredDraft(email) {
  const profileId = await expiredDraftProfileId(email);
  if (profileId) await require('./managers').removeUnclaimedDraft(profileId);
}

function toClientUser(user) {
  const {
    password: _password,
    emailVerificationToken: _emailVerificationToken,
    tokenVersion: _tokenVersion,
    requiresPasswordReset: _requiresPasswordReset,
    pendingEmailTokenHash: _pendingEmailTokenHash,
    ...safeUser
  } = user
  return safeUser
}

// ─────────────────────────────────────────────
// VALIDATION SIRET via API gouvernementale
// GET /api/auth/validate-siret?siret=xxx
// ─────────────────────────────────────────────
router.get('/validate-siret', siretCheckLimiter, async (req, res) => {
  const raw = String(req.query.siret || '').replace(/\s/g, '')
  if (!/^\d{14}$/.test(raw)) {
    return res.status(400).json({ valid: false, error: 'Format invalide — 14 chiffres requis' })
  }
  try {
    const apiRes = await fetch(
      `https://recherche-entreprises.api.gouv.fr/search?q=${raw}&page=1&per_page=1`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    )
    if (!apiRes.ok) return res.json({ valid: false, error: 'Service indisponible, réessayez' })
    const data = await apiRes.json()
    if (data.total_results > 0) {
      const company = data.results[0]
      const name = company.nom_complet || company.siege?.denomination || ''
      return res.json({ valid: true, companyName: name })
    }
    return res.json({ valid: false, error: 'SIRET introuvable dans le registre officiel' })
  } catch (err) {
    console.error('❌ validate-siret:', err)
    return res.status(500).json({ valid: false, error: 'Erreur lors de la vérification' })
  }
})

// ─────────────────────────────────────────────
// VÉRIFICATION DISPONIBILITÉ DU PSEUDO
// GET /api/auth/check-pseudo?pseudo=xxx
// ─────────────────────────────────────────────
router.get('/check-pseudo', pseudoCheckLimiter, async (req, res) => {
  const pseudo = (req.query.pseudo || '').trim();
  if (!pseudo || pseudo.length < 3) {
    return res.json({ available: false });
  }
  try {
    const existing = await prisma.user.findUnique({ where: { pseudo } });
    return res.json({ available: !existing });
  } catch (err) {
    console.error('Erreur dans /check-pseudo :', err);
    return res.status(500).json({ available: false });
  }
});

// ─────────────────────────────────────────────
// GET /api/auth/check-email?email=xxx — e-mail déjà inscrit ? (dès l'étape 1 de l'inscription)
// ─────────────────────────────────────────────
router.get('/check-email', pseudoCheckLimiter, async (req, res) => {
  const email = String(req.query.email || '').toLowerCase().trim();
  if (!email || email.length > 254) return res.json({ available: true });
  try {
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    const available = !existing || !!(await expiredDraftProfileId(email));
    return res.json({ available });
  } catch (err) {
    console.error('Erreur dans /check-email :', err);
    return res.status(500).json({ available: true });
  }
});

// ─────────────────────────────────────────────
// INSCRIPTION COMPLETE (toutes les données d'un coup)
// POST /api/auth/register-complete
// Collecte : email, password, role,
//            pseudo, firstName, lastName, dateOfBirth, phone, countryOfResidence,
//            legalStatus, organizerType, establishmentName, typeEtablissement, siret, city
// ─────────────────────────────────────────────
router.post('/register-complete', validate(registerCompleteSchema), async (req, res) => {
  const {
    email, password, role,
    pseudo, firstName, lastName, dateOfBirth, phone, countryOfResidence,
    legalStatus, organizerType, establishmentName, typeEtablissement, siret, city,
    specialties,
  } = req.body;

  try {
    // Profil préparé par une agence, jamais validé et dont le lien a expiré : l'adresse redevient libre
    await releaseExpiredDraft(email.toLowerCase().trim());

    // Vérifier email unique
    const existingEmail = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existingEmail) {
      return res.status(400).json({ error: 'Utilisateur déjà inscrit avec cet email' });
    }

    // Vérifier pseudo unique
    const existingPseudo = await prisma.user.findUnique({ where: { pseudo } });
    if (existingPseudo) {
      return res.status(409).json({ error: 'Ce pseudo est déjà utilisé' });
    }

    // Re-valider le SIRET côté serveur si statut professionnel
    if (legalStatus === 'COMPANY' && siret) {
      const raw = siret.replace(/\s/g, '')
      if (!/^\d{14}$/.test(raw)) {
        return res.status(400).json({ error: 'Format SIRET invalide — 14 chiffres requis' })
      }
      try {
        const siretRes = await fetch(
          `https://recherche-entreprises.api.gouv.fr/search?q=${raw}&page=1&per_page=1`,
          { headers: { Accept: 'application/json' } }
        )
        if (siretRes.ok) {
          const siretData = await siretRes.json()
          if (!siretData.total_results || siretData.total_results === 0) {
            return res.status(400).json({ error: 'SIRET introuvable dans le registre officiel' })
          }
        }
        // Si l'API est indisponible on laisse passer (évite de bloquer l'inscription)
      } catch (siretErr) {
        console.error('⚠️ validate-siret (register-complete):', siretErr)
      }
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');

    // Construire les données du profil (étape 3)
    const profileData = {};
    if (legalStatus) profileData.legalStatus = legalStatus;
    if (organizerType) profileData.organizerType = organizerType;
    if (establishmentName) profileData.establishmentName = establishmentName.trim();
    if (typeEtablissement) profileData.typeEtablissement = typeEtablissement.trim();
    if (siret) profileData.siret = siret.trim();
    if (city) profileData.location = city.trim();
    if (countryOfResidence) profileData.country = countryOfResidence.trim();
    if (Array.isArray(specialties) && specialties.length > 0) profileData.specialties = specialties;
    // Organisateur : le premier métier coché devient son type d'établissement (affiché et filtré dans la recherche)
    if (role === 'ORGANIZER' && !profileData.typeEtablissement && profileData.specialties?.length) profileData.typeEtablissement = profileData.specialties[0];

    // Construire les données utilisateur (étape 2)
    const userData = {
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      role,
      pseudo,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      isAdmin: false,
      registrationStep: 3,
      emailVerified: false,
      emailVerificationToken,
      profile: { create: profileData },
    };
    if (dateOfBirth) userData.dateOfBirth = new Date(dateOfBirth);
    if (phone) userData.phone = phone.trim();
    if (countryOfResidence) userData.countryOfResidence = countryOfResidence.trim();
    // Intermittent payé en cachet : ses bookings se règlent en direct (déclaration GUSO)
    if (legalStatus === 'INTERMITTENT') userData.payoutMode = 'INTERMITTENT';

    const user = await prisma.user.create({
      data: userData,
      include: { profile: true },
    });

    // Envoi de l'email de vérification
    sendVerificationEmail(user.email, emailVerificationToken).catch(err =>
      console.error('Erreur envoi email vérification:', err)
    );

    res.status(201).json({
      message: 'Compte créé. Vérifiez votre adresse email avant de vous connecter.',
      requiresEmailVerification: true,
    });
  } catch (err) {
    console.error('Erreur dans /register-complete :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// CONNEXION
// ─────────────────────────────────────────────
router.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { profile: true },
    });

    // Message generique pour ne pas indiquer si l'email existe
    if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      if (isAdminUser(user)) logAdmin(req, 'ADMIN_PASSWORD_FAILED', { adminId: user.id, details: { device: deviceNameFromUA(req.headers['user-agent'] || '') } })
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    // Bloquer la connexion si email non verifie
    if (!user.emailVerified) {
      return res.status(403).json({ error: 'EMAIL_NOT_VERIFIED' });
    }

    if (user.requiresPasswordReset) {
      return res.status(403).json({ error: 'PASSWORD_RESET_REQUIRED' })
    }

    // Compte suspendu par l'admin (ex. annulations répétées à moins de 7 jours)
    if (user.bannedAt) {
      return res.status(403).json({ error: 'ACCOUNT_BANNED', message: 'Ce compte a été suspendu. Pour toute question : contact@lsbookers.com' })
    }

    // Compte admin : le mot de passe ne suffit pas, un code à 6 chiffres part par e-mail
    if (isAdminUser(user)) {
      const challenge = await sendAdminLoginCode(req, user)
      return res.json({ twoFactorRequired: true, challenge, emailHint: maskEmail(user.email) })
    }

    await completeLogin(req, res, user)
  } catch (err) {
    console.error('Erreur serveur lors de la connexion :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/** Ouvre la session et répond au site (connexion normale, ou admin après le code) */
async function completeLogin(req, res, user, { admin = false } = {}) {
  // Une session par appareil (listée et révocable dans Réglages › Connexion et sécurité)
  const { token, isNewDevice, deviceName } = await issueSession(req, res, user, {
    admin,
    deviceHint: req.headers['x-device-token'] || null,
    standalone: req.body?.standalone === true,
  })
  // Compteur « Connexions » de l'admin (les connexions admin sont dans l'Historique)
  if (!admin) {
    prisma.loginEvent.create({ data: { userId: user.id, userAgent: String(req.headers['user-agent'] || '').slice(0, 300) || null } })
      .catch(err => console.error('Connexion non comptée :', err.message))
  }
  if (isNewDevice && user.loginAlerts && !admin) {
    const date = new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' })
    createNotif({ userId: user.id, type: 'NEW_DEVICE_LOGIN', content: `Nouvelle connexion à votre compte : ${deviceName}, le ${date}.` })
    // « Ce n'était pas moi » : lien valable 7 jours, utilisable sans être connecté
    emailUtils.sendLoginAlertEmail(user.email, { deviceName, date, secureToken: signSecureAccountToken(user) })
      .catch(err => console.error('❌ Alerte de connexion :', err.message))
  }
  // Mode « cookie uniquement » (site et API sur le même site) : le jeton n'est jamais
  // renvoyé au JavaScript de la page. Sinon (API sur railway.app), transition : jeton renvoyé.
  // Formule Business : le site sait tout de suite qu'il peut afficher le sélecteur de profils
  const body = { message: 'Connexion reussie', user: { ...toClientUser(user), hasAgency: await hasAgency(user).catch(() => false) } }
  if (!isSameSiteRequest(req)) body.token = token
  res.json(body);
}

// ─────────────────────────────────────────────
// CONNEXION ADMIN : CODE DE SÉCURITÉ PAR E-MAIL (31/10/2026)
// 1) /login (bon mot de passe) → code à 6 chiffres envoyé, valable 10 min, 5 essais
// 2) /admin-code { challenge, code } → session admin (1 h sans activité, 6 h au plus)
// ─────────────────────────────────────────────
const ADMIN_CODE_TTL_MS = 10 * 60 * 1000
const ADMIN_CODE_MAX_ATTEMPTS = 5

const hashAdminCode = (challenge, code) =>
  crypto.createHmac('sha256', process.env.JWT_SECRET || 'lsb').update(`${challenge}:${code}`).digest('hex')

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@')
  if (!domain) return ''
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`
}

async function sendAdminLoginCode(req, user) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  const challenge = crypto.randomBytes(24).toString('hex')
  // Un seul code valable à la fois : les précédents sont annulés
  await prisma.adminLoginCode.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } })
  await prisma.adminLoginCode.create({
    data: { userId: user.id, challenge, codeHash: hashAdminCode(challenge, code), expiresAt: new Date(Date.now() + ADMIN_CODE_TTL_MS) },
  })
  const deviceName = deviceNameFromUA(req.headers['user-agent'] || '')
  const date = new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' })
  await emailUtils.sendAdminLoginCodeEmail(user.email, { code, deviceName, date })
  logAdmin(req, 'ADMIN_CODE_SENT', { adminId: user.id, details: { device: deviceName } })
  return challenge
}

router.post('/admin-code', async (req, res) => {
  const challenge = String(req.body?.challenge || '')
  const code = String(req.body?.code || '').replace(/\s+/g, '')
  if (!/^[a-f0-9]{48}$/.test(challenge) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'ADMIN_CODE_INVALID' })
  }
  try {
    const row = await prisma.adminLoginCode.findUnique({ where: { challenge } })
    if (!row || row.usedAt || row.expiresAt < new Date() || row.attempts >= ADMIN_CODE_MAX_ATTEMPTS) {
      return res.status(401).json({ error: 'ADMIN_CODE_EXPIRED' })
    }
    const expected = Buffer.from(row.codeHash, 'hex')
    const given = Buffer.from(hashAdminCode(challenge, code), 'hex')
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      const attempts = row.attempts + 1
      await prisma.adminLoginCode.update({
        where: { id: row.id },
        data: { attempts, ...(attempts >= ADMIN_CODE_MAX_ATTEMPTS ? { usedAt: new Date() } : {}) },
      })
      logAdmin(req, 'ADMIN_CODE_FAILED', { adminId: row.userId, details: { attempts } })
      const left = ADMIN_CODE_MAX_ATTEMPTS - attempts
      return res.status(401).json({ error: left > 0 ? 'ADMIN_CODE_WRONG' : 'ADMIN_CODE_EXPIRED', attemptsLeft: Math.max(0, left) })
    }
    // Code utilisé une seule fois (deux envois simultanés : un seul ouvre la session)
    const claimed = await prisma.adminLoginCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } })
    if (claimed.count !== 1) return res.status(401).json({ error: 'ADMIN_CODE_EXPIRED' })

    const user = await prisma.user.findUnique({ where: { id: row.userId }, include: { profile: true } })
    if (!user || !isAdminUser(user) || user.bannedAt || !user.emailVerified || user.requiresPasswordReset) {
      return res.status(401).json({ error: 'ADMIN_CODE_EXPIRED' })
    }
    logAdmin(req, 'ADMIN_LOGIN', { adminId: user.id, details: { device: deviceNameFromUA(req.headers['user-agent'] || '') } })
    await completeLogin(req, res, user, { admin: true })
  } catch (err) {
    console.error('Erreur code admin :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─────────────────────────────────────────────
// DÉCONNEXION
// ─────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  // Effacer lastActiveAt pour que le statut "en ligne" disparaisse immédiatement
  try {
    const authHeader = req.headers.authorization
    const cookieToken = req.cookies?.token
    const rawToken = (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null) || cookieToken
    if (rawToken) {
      const decoded = jwt.verify(rawToken, process.env.JWT_SECRET)
      if (decoded?.id) {
        await prisma.user.update({ where: { id: decoded.id }, data: { lastActiveAt: null } }).catch(() => {})
      }
      // Cet appareil disparaît de la liste des appareils connectés
      if (typeof decoded?.sid === 'string') {
        await prisma.userSession.updateMany({ where: { sid: decoded.sid, revokedAt: null }, data: { revokedAt: new Date() } }).catch(() => {})
      }
    }
  } catch {}
  clearSessionCookie(req, res);
  res.json({ message: 'Déconnecté' });
});

// ─────────────────────────────────────────────
// SUPPRESSION DE SON PROPRE COMPTE (RGPD)
// Confirmation par mot de passe. Supprime toutes les données et fichiers.
// ─────────────────────────────────────────────
const deleteAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: memberOrIp, // par membre (ou par IP hors connexion)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez plus tard' },
});

router.delete('/account', deleteAccountLimiter, requireAuth, validate(deleteAccountSchema), async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, role: true, password: true },
    });
    if (!user) return res.status(404).json({ error: 'Compte introuvable' });
    if (isAdminUser(user)) {
      return res.status(403).json({ error: 'Un compte admin ne peut pas être supprimé depuis le site' });
    }

    const isValid = await bcrypt.compare(req.body.password, user.password);
    if (!isValid) return res.status(401).json({ error: 'Mot de passe incorrect' });

    await deleteUserAccount(user.id);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur suppression de compte :', err);
    res.status(500).json({ error: 'Impossible de supprimer le compte' });
  }
});

// ─────────────────────────────────────────────
// CONVERSION D'UNE ANCIENNE SESSION (jeton localStorage) EN COOKIE httpOnly
// Appelée une seule fois par le site lors du passage au mode « cookie uniquement ».
// ─────────────────────────────────────────────
router.post('/session', requireAuth, (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) setSessionCookie(req, res, token);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// VÉRIFICATION EMAIL
// ─────────────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  return res.status(405).json({ error: 'Confirmation explicite requise' })
})


router.post('/verify-email', async (req, res) => {
  const { token } = req.body || {};

  if (!token) {
    return res.status(400).json({ error: 'Token manquant' });
  }

  try {
    const verified = await prisma.$transaction(async tx => {
      const user = await tx.user.findUnique({ where: { emailVerificationToken: token } })
      if (!user) return false

      const claimed = await tx.user.updateMany({
        where: { id: user.id, emailVerificationToken: token, emailVerified: false },
        data: { emailVerified: true, emailVerificationToken: null },
      })
      if (claimed.count !== 1) return false

      return true
    })

    if (!verified) return res.status(400).json({ error: 'Lien invalide ou deja utilise' });

    res.json({ message: 'Email verifie avec succes' });
  } catch (err) {
    console.error('Erreur dans /verify-email :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Renvoi de l'email de verification
router.post('/resend-verification', validate(resendVerificationSchema), async (req, res) => {
  const { email } = req.body;

  try {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    // Reponse generique pour ne pas exposer si l'email existe
    if (!user || user.emailVerified) {
      return res.json({ message: 'Si un compte non verifie existe, un email sera envoye.' });
    }

    const newToken = crypto.randomBytes(32).toString('hex');
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerificationToken: newToken },
    });

    sendVerificationEmail(user.email, newToken).catch(err =>
      console.error('Erreur renvoi email verification:', err)
    );

    res.json({ message: 'Email de verification renvoye.' });
  } catch (err) {
    console.error('Erreur dans /resend-verification :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// HEARTBEAT — maintient le statut "en ligne"
// ─────────────────────────────────────────────
router.post('/heartbeat', requireAuth, async (req, res) => {
  try {
    // Un agent qui agit pour un artiste reste « en ligne » lui-même, pas l'artiste
    await prisma.user.update({
      where: { id: (req.actor || req.user).id },
      data: { lastActiveAt: new Date() },
    });
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

// ─────────────────────────────────────────────
// /me — recupere l'utilisateur connecte
// ─────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { profile: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    // Profil géré : le site s'affiche comme le profil, sans les données personnelles du titulaire
    if (req.actor) {
      return res.json({
        user: hidePrivateFromManager(toClientUser(user)),
        acting: {
          profileId: req.management.profileId,
          requireApproval: req.management.requireApproval,
          manager: { id: req.actor.id, name: accountName(req.actor), avatar: req.actor.profile?.avatar || null, profileId: req.actor.profile?.id || null },
        },
      });
    }
    const safeUser = toClientUser(user);
    safeUser.hasAgency = await hasAgency(user); // formule Agence (payée ou offerte) : gérer plusieurs profils
    res.json({ user: safeUser });
  } catch (err) {
    console.error('Erreur dans /me :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
