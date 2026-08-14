const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const {
  registerSchema,
  loginSchema,
  step2Schema,
  step3Schema,
  registerCompleteSchema,
  resendVerificationSchema,
} = require('../schemas');
const { sendVerificationEmail } = require('../utils/email');

// ─────────────────────────────────────────────
// ETAPE 1 : CREATION DU COMPTE
// Collecte : email, password, role
// ─────────────────────────────────────────────
router.post('/register', validate(registerSchema), async (req, res) => {
  const { email, password, role } = req.body;

  try {
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) {
      return res.status(400).json({ error: 'Utilisateur deja inscrit' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        role,
        isAdmin: false,
        registrationStep: 1,
        emailVerified: false,
        emailVerificationToken,
        profile: { create: {} },
      },
      include: { profile: true },
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, isAdmin: user.isAdmin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Envoi de l'email de verification (en arriere-plan)
    sendVerificationEmail(user.email, emailVerificationToken).catch(err =>
      console.error('Erreur envoi email verification:', err)
    );

    const { password: _pw, ...safeUser } = user;

    // Cookie httpOnly dès l'inscription
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({ message: 'Compte cree', token, user: safeUser });
  } catch (err) {
    console.error('Erreur dans /register :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// ETAPE 2 : IDENTITE
// Collecte : pseudo, firstName, lastName, dateOfBirth, phone, countryOfResidence
// ─────────────────────────────────────────────
router.patch('/step2', requireAuth, validate(step2Schema), async (req, res) => {
  const { pseudo, firstName, lastName, dateOfBirth, phone, countryOfResidence } = req.body;

  try {
    // Verifier que le pseudo n'est pas deja pris par quelqu'un d'autre
    const takenBy = await prisma.user.findUnique({ where: { pseudo } });
    if (takenBy && takenBy.id !== req.user.id) {
      return res.status(409).json({ error: 'Ce pseudo est deja utilise' });
    }

    const data = {
      pseudo,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      registrationStep: 2,
    };

    if (dateOfBirth) data.dateOfBirth = new Date(dateOfBirth);
    if (phone) data.phone = phone.trim();
    if (countryOfResidence) data.countryOfResidence = countryOfResidence.trim();

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
    });

    const { password: _pw, ...safeUser } = user;
    res.json({ message: 'Identite enregistree', user: safeUser });
  } catch (err) {
    console.error('Erreur dans /step2 :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─────────────────────────────────────────────
// ETAPE 3 : PROFIL & INFOS LEGALES
// Collecte : bio, profession, location, country, legalStatus,
//            organizerType, establishmentName, typeEtablissement,
//            siret, address, postalCode, city
// ─────────────────────────────────────────────
router.patch('/step3', requireAuth, validate(step3Schema), async (req, res) => {
  const {
    bio, profession, location, country, legalStatus,
    organizerType, establishmentName, typeEtablissement,
    siret, address, postalCode, city,
  } = req.body;

  try {
    const profileData = {};

    if (bio) profileData.bio = bio.trim();
    if (profession) profileData.profession = profession.trim();
    if (location) profileData.location = location.trim();
    if (country) profileData.country = country.trim();
    if (legalStatus) profileData.legalStatus = legalStatus;
    if (organizerType) profileData.organizerType = organizerType;
    if (establishmentName) profileData.establishmentName = establishmentName.trim();
    if (typeEtablissement) profileData.typeEtablissement = typeEtablissement.trim();
    if (siret) profileData.siret = siret.trim();
    if (address) profileData.address = address.trim();
    if (postalCode) profileData.postalCode = postalCode.trim();
    if (city) profileData.city = city.trim();

    await prisma.profile.update({
      where: { userId: req.user.id },
      data: profileData,
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { registrationStep: 3 },
    });

    res.json({ message: 'Profil enregistre' });
  } catch (err) {
    console.error('Erreur dans /step3 :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

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
    if (city) profileData.city = city.trim();
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

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, isAdmin: user.isAdmin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Envoi de l'email de vérification
    sendVerificationEmail(user.email, emailVerificationToken).catch(err =>
      console.error('Erreur envoi email vérification:', err)
    );

    const { password: _pw, ...safeUser } = user;

    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({ message: 'Compte créé', token, user: safeUser });
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
      { id: user.id, email: user.email, role: user.role, isAdmin: user.isAdmin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const { password: _pw, ...safeUser } = user;

    // Cookie httpOnly — non accessible par JavaScript
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 jours
    });

    // Enregistrer l'événement de connexion (en arrière-plan)
    prisma.loginEvent.create({ data: { userId: user.id } }).catch(() => {})

    res.json({ message: 'Connexion reussie', token, user: safeUser });
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

    const { password: _pw, ...safeUser } = user;
    res.json({ user: safeUser });
  } catch (err) {
    console.error('Erreur dans /me :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
