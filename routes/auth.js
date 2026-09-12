const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const {
  loginSchema,
  registerCompleteSchema,
  resendVerificationSchema,
} = require('../schemas');
const { sendVerificationEmail } = require('../utils/email');

// Rate limiting pour les routes publiques d'énumération
const pseudoCheckLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,             // max 20 vérifications par minute par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de vérifications, réessayez dans une minute' },
});

// Ne jamais exposer les secrets et compteurs internes du compte au navigateur.
function toClientUser(user) {
  const {
    password: _password,
    emailVerificationToken: _emailVerificationToken,
    tokenVersion: _tokenVersion,
    requiresPasswordReset: _requiresPasswordReset,
    ...safeUser
  } = user
  return safeUser
}

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
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    // Bloquer la connexion si email non verifie
    if (!user.emailVerified) {
      return res.status(403).json({ error: 'EMAIL_NOT_VERIFIED' });
    }

    if (user.requiresPasswordReset) {
      return res.status(403).json({ error: 'PASSWORD_RESET_REQUIRED' })
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, isAdmin: user.isAdmin, tokenVersion: user.tokenVersion },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )
    const isProduction = process.env.NODE_ENV === 'production'
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
    res.json({ message: 'Connexion reussie', token, user: toClientUser(user) });
  } catch (err) {
    console.error('Erreur serveur lors de la connexion :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// DÉCONNEXION
// ─────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production';
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
    }
  } catch {}
  res.clearCookie('token', {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
  });
  res.json({ message: 'Déconnecté' });
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
    await prisma.user.update({
      where: { id: req.user.id },
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

    const safeUser = toClientUser(user);
    res.json({ user: safeUser });
  } catch (err) {
    console.error('Erreur dans /me :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
