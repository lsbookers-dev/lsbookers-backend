const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const {
  loginSchema,
  registerCompleteSchema,
  resendVerificationSchema,
} = require('../schemas');
const { sendVerificationEmail, sendNewDeviceEmail } = require('../utils/email');
const { createNotif } = require('../services/notifications');

// ─────────────────────────────────────────────
// Helper — parse User-Agent en texte lisible
// ─────────────────────────────────────────────
function parseUserAgent(ua) {
  if (!ua) return 'appareil inconnu'
  let browser = 'navigateur inconnu'
  let os = ''
  if      (ua.includes('Edg/'))                                    browser = 'Edge'
  else if (ua.includes('OPR/') || ua.includes('Opera/'))           browser = 'Opera'
  else if (ua.includes('Chrome/') && !ua.includes('Chromium/'))    browser = 'Chrome'
  else if (ua.includes('Firefox/'))                                browser = 'Firefox'
  else if (ua.includes('Safari/') && !ua.includes('Chrome/'))      browser = 'Safari'
  else if (ua.includes('MSIE') || ua.includes('Trident/'))         browser = 'Internet Explorer'
  if      (ua.includes('iPhone'))       os = 'iPhone'
  else if (ua.includes('iPad'))         os = 'iPad'
  else if (ua.includes('Android'))      os = 'Android'
  else if (ua.includes('Windows NT'))   os = 'Windows'
  else if (ua.includes('Mac OS X'))     os = 'Mac'
  else if (ua.includes('Linux'))        os = 'Linux'
  return os ? `${browser} sur ${os}` : browser
}

// Ne jamais exposer les secrets et compteurs internes du compte au navigateur.
function toClientUser(user) {
  const {
    password: _password,
    emailVerificationToken: _emailVerificationToken,
    tokenVersion: _tokenVersion,
    ...safeUser
  } = user
  return safeUser
}

// ─────────────────────────────────────────────
// VÉRIFICATION DISPONIBILITÉ DU PSEUDO
// GET /api/auth/check-pseudo?pseudo=xxx
// ─────────────────────────────────────────────
router.get('/check-pseudo', async (req, res) => {
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

    const isProduction = process.env.NODE_ENV === 'production';
    // ── Appareil de création = automatiquement de confiance ──
    const ua              = req.headers['user-agent'] || null
    const deviceName      = parseUserAgent(ua)
    const registerToken   = crypto.randomUUID()

    res.cookie('device_token', registerToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    })

    await prisma.trustedDevice.create({
      data: { userId: user.id, deviceToken: registerToken, name: deviceName, userAgent: ua },
    }).catch(() => {}) // silencieux si erreur

    res.status(201).json({
      message: 'Compte créé. Vérifiez votre adresse email avant de vous connecter.',
      requiresEmailVerification: true,
      deviceToken: registerToken,
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
    if (!user) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    // Bloquer la connexion si email non verifie
    if (!user.emailVerified) {
      return res.status(403).json({ error: 'EMAIL_NOT_VERIFIED' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, isAdmin: user.isAdmin, tokenVersion: user.tokenVersion },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const safeUser = toClientUser(user);

    const isProduction = process.env.NODE_ENV === 'production';

    // Cookie httpOnly session
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // ── Détection appareil — AVANT res.json() pour pouvoir set le cookie ────
    // Priorité : header X-Device-Token (localStorage) > cookie (fallback)
    let deviceTokenForClient = null
    try {
      const ua             = req.headers['user-agent'] || null
      const providedToken  = req.headers['x-device-token'] || req.cookies?.device_token || null

      if (providedToken) {
        // 1. Appareil de confiance → silencieux
        const trusted = await prisma.trustedDevice.findFirst({
          where: { userId: user.id, deviceToken: providedToken },
        })
        if (trusted) {
          await prisma.loginEvent.create({ data: { userId: user.id, userAgent: ua, deviceToken: providedToken } })
          deviceTokenForClient = providedToken
        } else {
          // 2. Appareil déjà vu (email déjà envoyé) → silencieux
          const seen = await prisma.loginEvent.findFirst({
            where: { userId: user.id, deviceToken: providedToken },
          })
          if (seen) {
            await prisma.loginEvent.create({ data: { userId: user.id, userAgent: ua, deviceToken: providedToken } })
            deviceTokenForClient = providedToken
          }
        }
      }

      if (!deviceTokenForClient) {
        // 3. Nouvel appareil → générer token, set cookie, envoyer email
        const newDeviceToken = crypto.randomUUID()

        res.cookie('device_token', newDeviceToken, {
          httpOnly: true,
          secure: isProduction,
          sameSite: isProduction ? 'none' : 'lax',
          maxAge: 30 * 24 * 60 * 60 * 1000, // 30 jours
        })
        deviceTokenForClient = newDeviceToken

        const prevLoginCount = await prisma.loginEvent.count({ where: { userId: user.id } })
        if (prevLoginCount > 0) {
          const deviceLabel = parseUserAgent(ua)
          const verifToken  = crypto.randomBytes(32).toString('hex')
          const expiresAt   = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h

          await prisma.deviceVerification.create({
            data: { token: verifToken, userId: user.id, deviceToken: newDeviceToken, deviceName: deviceLabel, expiresAt },
          })

          const APP_URL    = process.env.APP_URL || 'https://www.lsbookers.com'
          const trustLink  = `${APP_URL}/device-verified?token=${verifToken}&action=trust`
          const rejectLink = `${APP_URL}/device-verified?token=${verifToken}&action=reject`

          sendNewDeviceEmail(user.email, {
            deviceName: deviceLabel,
            date:       new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
            trustLink,
            rejectLink,
          }).catch(err => console.error('Erreur sendNewDeviceEmail :', err))

          createNotif({
            userId:  user.id,
            type:    'NEW_DEVICE_LOGIN',
            content: `Nouvelle connexion depuis : ${deviceLabel}. Vérifiez votre email pour confirmer ou sécuriser votre compte.`,
          })
        }

        await prisma.loginEvent.create({ data: { userId: user.id, userAgent: ua, deviceToken: newDeviceToken } })
      }
    } catch (err) {
      console.error('Erreur détection appareil :', err)
    }

    res.json({ message: 'Connexion reussie', token, user: safeUser, deviceToken: deviceTokenForClient });
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
// VÉRIFICATION APPAREIL PAR EMAIL (lien one-time)
// GET /api/auth/device-verify?token=xxx&action=trust|reject
// Pas d'auth requise (lien reçu par email)
// ─────────────────────────────────────────────
router.get('/device-verify', async (req, res) => {
  const { token, action } = req.query
  if (!token || !['trust', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Lien invalide' })
  }

  try {
    const verif = await prisma.deviceVerification.findUnique({ where: { token } })

    if (!verif)               return res.status(400).json({ error: 'Lien invalide ou déjà utilisé' })
    if (verif.usedAt)         return res.status(400).json({ error: 'Ce lien a déjà été utilisé' })
    if (verif.expiresAt < new Date()) return res.status(400).json({ error: 'Ce lien a expiré' })

    // Marquer le token comme utilisé
    await prisma.deviceVerification.update({
      where: { id: verif.id },
      data:  { usedAt: new Date() },
    })

    if (action === 'trust') {
      // Ajouter l'appareil en liste de confiance
      const existing = await prisma.trustedDevice.findUnique({ where: { deviceToken: verif.deviceToken } })
      if (!existing) {
        await prisma.trustedDevice.create({
          data: { userId: verif.userId, deviceToken: verif.deviceToken, name: verif.deviceName, userAgent: null },
        })
      }
      return res.json({ message: 'Appareil confirmé', deviceName: verif.deviceName })
    }

    if (action === 'reject') {
      // Incrémenter tokenVersion → tous les JWT existants deviennent invalides
      await prisma.user.update({
        where: { id: verif.userId },
        data:  { tokenVersion: { increment: 1 } },
      })
      // Supprimer tous les appareils de confiance (reset sécurité complet)
      await prisma.trustedDevice.deleteMany({ where: { userId: verif.userId } })
      return res.json({ message: 'Compte sécurisé. Toutes vos sessions ont été fermées.' })
    }
  } catch (err) {
    console.error('Erreur device-verify :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─────────────────────────────────────────────
// VERIFICATION EMAIL
// ─────────────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Token manquant' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { emailVerificationToken: token },
    });

    if (!user) {
      return res.status(400).json({ error: 'Lien invalide ou deja utilise' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailVerificationToken: null },
    });

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
