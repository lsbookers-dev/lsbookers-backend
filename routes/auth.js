const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAuth } = require('../middleware/auth');

// ROUTE D'INSCRIPTION
router.post('/register', async (req, res) => {
  // isAdmin n'est jamais accepte depuis le client - toujours false a l'inscription
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Champs requis manquants' });
  }

  // ADMIN ne peut pas s'inscrire via ce formulaire
  const validRoles = ['ARTIST', 'ORGANIZER', 'PROVIDER'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Role invalide: ' + role });
  }

  // Validation basique de l'email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Adresse email invalide' });
  }

  // Mot de passe minimum 8 caracteres
  if (password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caracteres' });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existingUser) {
      return res.status(400).json({ error: 'Utilisateur deja inscrit' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        role,
        isAdmin: false,
        profile: { create: {} },
      },
      include: { profile: true },
    });

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        isAdmin: user.isAdmin,
        name: user.name,
        avatar: user.profile ? user.profile.avatar : null,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Ne jamais renvoyer le mot de passe hache au client
    const { password: _pw, ...safeUser } = user;

    res.status(201).json({
      message: 'Inscription reussie',
      token,
      user: safeUser,
    });
  } catch (err) {
    console.error('Erreur dans /register :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ROUTE DE CONNEXION
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
      {
        id: user.id,
        email: user.email,
        role: user.role,
        isAdmin: user.isAdmin,
        name: user.name,
        avatar: user.profile ? user.profile.avatar : null,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Ne jamais renvoyer le mot de passe hache au client
    const { password: _pw, ...safeUser } = user;

    res.json({
      message: 'Connexion reussie',
      token,
      user: safeUser,
    });
  } catch (err) {
    console.error('Erreur serveur lors de la connexion :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ROUTE SECURISEE /me
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
