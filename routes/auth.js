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
const { sendVerificationEmail, sendNewDeviceEmail } = require('../utils/email');

const DEVICE_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DEVICE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000
const DEVICE_VERIFICATION_TTL = 24 * 60 * 60 * 1000
const DEVICE_ALERT_COOLDOWN = 15 * 60 * 1000

function validDeviceToken(value) {
  return typeof value === 'string' && DEVICE_TOKEN_RE.test(value)
}

function readDeviceTokens(req) {
  const cookieToken = req.cookies?.device_token
  const headerToken = req.headers['x-device-token']
  return [...new Set([cookieToken, headerToken].filter(validDeviceToken))]
}

function readDeviceToken(req) {
  return readDeviceTokens(req)[0] || null
}

function setDeviceCookie(res, deviceToken) {
  const isProduction = process.env.NODE_ENV === 'production'
  res.cookie('device_token', deviceToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: DEVICE_COOKIE_MAX_AGE,
  })
}

function appUrl() {
  return (process.env.APP_URL || 'https://lsbookers.com').replace(/\/+$/, '')
}

class DeviceVerificationError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

async function verificationErrorResponse(prismaClient, token, res) {
  const verif = await prismaClient.deviceVerification.findUnique({ where: { token } })
  if (!verif) return res.status(400).json({ error: 'Lien invalide' })
  if (verif.usedAt) return res.status(400).json({ error: 'Ce lien a déjà été utilisé' })
  return res.status(400).json({ error: 'Ce lien a expiré' })
}

// Rate limiting pour les routes publiques d'énumération
const pseudoCheckLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,             // max 20 vérifications par minute par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de vérifications, réessayez dans une minute' },
});

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
    const ua = req.headers['user-agent'] || null
    const deviceName = parseUserAgent(ua)
    const registerToken = readDeviceToken(req) || crypto.randomUUID()

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
      pendingTrustedDevice: {
        create: {
          deviceToken: registerToken,
          name: deviceName,
          userAgent: ua,
          expiresAt: new Date(Date.now() + DEVICE_VERIFICATION_TTL),
        },
      },
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

    // Le navigateur d'inscription est mémorisé, mais ne devient fiable qu'après
    // la validation explicite de l'email depuis ce même navigateur.
    setDeviceCookie(res, registerToken)

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

    const ua = req.headers['user-agent'] || null
    const deviceName = parseUserAgent(ua)
    const presentedDeviceTokens = readDeviceTokens(req)
    let deviceToken = presentedDeviceTokens[0] || crypto.randomUUID()
    const now = new Date()
    let emailChallenge = null

    emailChallenge = await prisma.$transaction(async tx => {
        // Sérialise la création d'alertes pour un même compte, y compris si
        // plusieurs appareils se connectent exactement au même instant.
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(1374389535::int, ($1)::int)', user.id)

        let trusted = null
        for (const candidateToken of presentedDeviceTokens) {
          trusted = await tx.trustedDevice.findUnique({
            where: { userId_deviceToken: { userId: user.id, deviceToken: candidateToken } },
          })
          if (trusted) {
            deviceToken = candidateToken
            break
          }
        }
        if (trusted) {
          await tx.trustedDevice.update({
            where: { userId_deviceToken: { userId: user.id, deviceToken } },
            data: { name: deviceName, userAgent: ua, lastUsedAt: now },
          })
          await tx.loginEvent.create({ data: { userId: user.id, userAgent: ua, deviceToken } })
          return null
        }

        // LoginEvent reste un journal d'audit et ne confère jamais la confiance.
        await tx.deviceVerification.updateMany({
          where: { userId: user.id, usedAt: null, expiresAt: { lte: now } },
          data: { usedAt: now },
        })

        const activeForDevice = await tx.deviceVerification.findFirst({
          where: { userId: user.id, deviceToken, usedAt: null, expiresAt: { gt: now } },
          orderBy: { createdAt: 'desc' },
        })
        const recentForAccount = await tx.deviceVerification.findFirst({
          where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - DEVICE_ALERT_COOLDOWN) } },
          orderBy: { createdAt: 'desc' },
        })

        let challenge = null
        if (!activeForDevice && !recentForAccount) {
          const verificationToken = crypto.randomBytes(32).toString('hex')
          challenge = await tx.deviceVerification.create({
            data: {
              token: verificationToken,
              userId: user.id,
              deviceToken,
              deviceName,
              expiresAt: new Date(now.getTime() + DEVICE_VERIFICATION_TTL),
            },
          })
          await tx.notification.create({
            data: {
              userId: user.id,
              type: 'NEW_DEVICE_LOGIN',
              content: `Nouvelle connexion depuis : ${deviceName}. Vérifiez votre email pour confirmer ou sécuriser votre compte.`,
              deviceToken,
            },
          })
        }

        await tx.loginEvent.create({ data: { userId: user.id, userAgent: ua, deviceToken } })
        return challenge
    })

    if (emailChallenge) {
      const baseUrl = appUrl()
      try {
        await sendNewDeviceEmail(user.email, {
          deviceName,
          date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
          trustLink: `${baseUrl}/device-verified?token=${emailChallenge.token}&action=trust`,
          rejectLink: `${baseUrl}/device-verified?token=${emailChallenge.token}&action=reject`,
        })
      } catch (err) {
        console.error('Erreur sendNewDeviceEmail :', err)
        // Retire le challenge sans email. Le cooldown court reste applicable,
        // puis une connexion ultérieure pourra retenter l'envoi.
        await prisma.$transaction(async tx => {
          await tx.deviceVerification.updateMany({
            where: { token: emailChallenge.token, usedAt: null },
            data: { usedAt: new Date() },
          })
          await tx.notification.deleteMany({
            where: {
              userId: user.id,
              type: 'NEW_DEVICE_LOGIN',
              deviceToken,
              ...(emailChallenge.createdAt ? { createdAt: { gte: emailChallenge.createdAt } } : {}),
            },
          })
        }).catch(cleanupError => console.error('Erreur nettoyage challenge non envoyé :', cleanupError))
      }
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
    setDeviceCookie(res, deviceToken)

    res.json({ message: 'Connexion reussie', token, user: toClientUser(user), deviceToken });
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
// VÉRIFICATION APPAREIL — TRUST (action explicite)
// ─────────────────────────────────────────────
router.get('/device-verify', async (req, res) => {
  return res.status(405).json({ error: 'Confirmation explicite requise' })
})

router.post('/device-verify-trust', async (req, res) => {
  const { token } = req.body || {}
  if (!token) return res.status(400).json({ error: 'Token manquant' })

  try {
    const result = await prisma.$transaction(async tx => {
      const verif = await tx.deviceVerification.findUnique({ where: { token } })
      if (!verif || verif.usedAt || verif.expiresAt <= new Date()) {
        throw new DeviceVerificationError('INVALID_OR_USED')
      }

      const claimed = await tx.deviceVerification.updateMany({
        where: { token, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      })
      if (claimed.count !== 1) throw new DeviceVerificationError('INVALID_OR_USED')

      await tx.trustedDevice.upsert({
        where: { userId_deviceToken: { userId: verif.userId, deviceToken: verif.deviceToken } },
        update: { name: verif.deviceName, lastUsedAt: new Date() },
        create: {
          userId: verif.userId,
          deviceToken: verif.deviceToken,
          name: verif.deviceName,
          userAgent: null,
        },
      })
      await tx.notification.updateMany({
        where: { userId: verif.userId, type: 'NEW_DEVICE_LOGIN', deviceToken: verif.deviceToken },
        data: { read: true },
      })
      return { deviceName: verif.deviceName }
    })

    return res.json({ message: 'Appareil confirmé', deviceName: result.deviceName })
  } catch (err) {
    if (err instanceof DeviceVerificationError) {
      return verificationErrorResponse(prisma, token, res)
    }
    console.error('Erreur device-verify trust :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─────────────────────────────────────────────
// VÉRIFICATION APPAREIL — REJECT (action destructive, POST requis)
// POST /api/auth/device-verify-reject
// Requiert un POST explicite depuis la page de confirmation →
// les scanners d'email (qui font des GET) ne peuvent PAS déclencher ça.
// ─────────────────────────────────────────────
router.post('/device-verify-reject', async (req, res) => {
  const { token } = req.body

  if (!token) {
    return res.status(400).json({ error: 'Token manquant' })
  }

  try {
    await prisma.$transaction(async tx => {
      const verif = await tx.deviceVerification.findUnique({ where: { token } })
      if (!verif || verif.usedAt || verif.expiresAt <= new Date()) {
        throw new DeviceVerificationError('INVALID_OR_USED')
      }

      const claimed = await tx.deviceVerification.updateMany({
        where: { token, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      })
      if (claimed.count !== 1) throw new DeviceVerificationError('INVALID_OR_USED')

      await tx.user.update({
        where: { id: verif.userId },
        data: { tokenVersion: { increment: 1 }, requiresPasswordReset: true },
      })
      await tx.trustedDevice.deleteMany({ where: { userId: verif.userId } })
      await tx.pendingTrustedDevice.deleteMany({ where: { userId: verif.userId } })
      await tx.deviceVerification.updateMany({
        where: { userId: verif.userId, usedAt: null },
        data: { usedAt: new Date() },
      })
      await tx.notification.updateMany({
        where: { userId: verif.userId, type: 'NEW_DEVICE_LOGIN' },
        data: { read: true },
      })
    })

    return res.json({ message: 'Compte sécurisé. Toutes vos sessions ont été fermées.' })
  } catch (err) {
    if (err instanceof DeviceVerificationError) {
      return verificationErrorResponse(prisma, token, res)
    }
    console.error('Erreur device-verify reject :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─────────────────────────────────────────────
// VERIFICATION EMAIL
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
    const presentedDeviceTokens = readDeviceTokens(req)
    const now = new Date()
    const verified = await prisma.$transaction(async tx => {
      const user = await tx.user.findUnique({ where: { emailVerificationToken: token } })
      if (!user) return false

      const claimed = await tx.user.updateMany({
        where: { id: user.id, emailVerificationToken: token, emailVerified: false },
        data: { emailVerified: true, emailVerificationToken: null },
      })
      if (claimed.count !== 1) return false

      const pending = await tx.pendingTrustedDevice.findUnique({ where: { userId: user.id } })
      if (
        pending &&
        pending.expiresAt > now &&
        presentedDeviceTokens.includes(pending.deviceToken)
      ) {
        await tx.trustedDevice.upsert({
          where: { userId_deviceToken: { userId: user.id, deviceToken: pending.deviceToken } },
          update: { name: pending.name, userAgent: pending.userAgent, lastUsedAt: now },
          create: {
            userId: user.id,
            deviceToken: pending.deviceToken,
            name: pending.name,
            userAgent: pending.userAgent,
            lastUsedAt: now,
          },
        })
      }
      await tx.pendingTrustedDevice.deleteMany({ where: { userId: user.id } })
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
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { emailVerificationToken: newToken },
      }),
      prisma.pendingTrustedDevice.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() + DEVICE_VERIFICATION_TTL) },
      }),
    ]);

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
