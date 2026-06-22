const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAuth } = require('../middleware/auth');

// ─────────────────────────────────────────────
// ETAPE 1 : CREATION DU COMPTE
// Collecte : email, password, role
// ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password, role } = req.body;

  if (!email || !password || !role) {
    return res.status(400).json({ error: 'Email, mot de passe et role sont requis' });
  }

  const validRoles = ['ARTIST', 'ORGANIZER', 'PROVIDER'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Role invalide' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Adresse email invalide' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caracteres' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) {
      return res.status(400).json({ error: 'Utilisateur deja inscrit' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        role,
        isAdmin: false,
        registrationStep: 1,
        profile: { create: {} },
      },
      include: { profile: true },
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, isAdmin: user.isAdmin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const { password: _pw, ...safeUser } = user;

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
router.patch('/step2', requireAuth, async (req, res) => {
  const { pseudo, firstName, lastName, dateOfBirth, phone, countryOfResidence } = req.body;

  if (!pseudo || !firstName || !lastName) {
    return res.status(400).json({ error: 'Pseudo, prenom et nom sont requis' });
  }

  // Pseudo : lettres, chiffres, tirets, underscores, points — 3 a 30 caracteres
  const pseudoRegex = /^[a-zA-Z0-9_.\-]{3,30}$/;
  if (!pseudoRegex.test(pseudo)) {
    return res.status(400).json({ error: 'Pseudo invalide : 3-30 caracteres, lettres/chiffres/tirets/underscores' });
  }

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
router.patch('/step3', requireAuth, async (req, res) => {
  const {
    bio,
    profession,
    location,
    country,
    legalStatus,
    organizerType,
    establishmentName,
    typeEtablissement,
    siret,
    address,
    postalCode,
    city,
  } = req.body;

  const validLegalStatuses = ['INDIVIDUAL', 'AUTO_ENTREPRENEUR', 'COMPANY'];
  if (legalStatus && !validLegalStatuses.includes(legalStatus)) {
    return res.status(400).json({ error: 'Statut legal invalide' });
  }

  const validOrganizerTypes = ['INDIVIDUAL', 'PROFESSIONAL'];
  if (organizerType && !validOrganizerTypes.includes(organizerType)) {
    return res.status(400).json({ error: 'Type organisateur invalide' });
  }

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
// CONNEXION
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

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

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, isAdmin: user.isAdmin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const { password: _pw, ...safeUser } = user;

    res.json({ message: 'Connexion reussie', token, user: safeUser });
  } catch (err) {
    console.error('Erreur serveur lors de la connexion :', err);
    res.status(500).json({ error: 'Erreur serveur' });
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
