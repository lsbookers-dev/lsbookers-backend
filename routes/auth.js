const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authMiddleware = require('../middleware/authMiddleware');

// 🔐 ROUTE D’INSCRIPTION
router.post('/register', async (req, res) => {
  console.log("📩 Données reçues à l'inscription :", req.body);

  const { name, email, password, role, isAdmin } = req.body;

  console.log("📌 Rôle reçu :", role);

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Champs requis manquants ❌' });
  }

  const validRoles = ['ARTIST', 'ORGANIZER', 'PROVIDER', 'ADMIN'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `Rôle invalide ❌ (${role})` });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Utilisateur déjà inscrit ❌' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    console.log("✅ Création du user avec :", {
      name,
      email,
      role,
      isAdmin: isAdmin ?? false,
    });

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role,
        isAdmin: isAdmin ?? false,
        profile: { create: {} },
      },
      include: { profile: true },
    });

    console.log("✅ Utilisateur créé :", user.email);

    // ✅ Générer un token directement à l'inscription
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        isAdmin: user.isAdmin,
        name: user.name,
        avatar: user.profile?.avatar || null,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Inscription réussie ✅',
      token,
      user,
    });
  } catch (err) {
    console.error('❌ Erreur dans /register :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// 🔑 ROUTE DE CONNEXION
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  console.log('📥 Données reçues pour /login :', { email, password });

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { profile: true },
    });

    if (!user) {
      console.log('❌ Email introuvable dans la base');
      return res.status(401).json({ error: 'Email incorrect ❌' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      console.log('❌ Mot de passe invalide');
      return res.status(401).json({ error: 'Mot de passe incorrect ❌' });
    }

    if (!process.env.JWT_SECRET) {
      console.error('❌ JWT_SECRET non défini dans .env');
      return res.status(500).json({ error: 'JWT secret non configuré ❌' });
    }

    // ✅ Ajout du name et avatar dans le JWT
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        isAdmin: user.isAdmin,
        name: user.name,
        avatar: user.profile?.avatar || null,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('✅ Connexion réussie pour :', user.email);

    res.json({
      message: 'Connexion réussie ✅',
      token,
      user,
    });
  } catch (err) {
    console.error('❌ Erreur serveur lors de la connexion :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// 👤 ROUTE SÉCURISÉE /me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { profile: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable ❌' });
    }

    res.json({ user });
  } catch (err) {
    console.error('❌ Erreur dans /me :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;