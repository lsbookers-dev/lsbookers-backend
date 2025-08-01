const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware'); // ✅ Nouveau middleware

// ✅ Vérifie si l'utilisateur connecté est un admin
router.get('/check', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: 'Accès refusé ❌' });
    }

    res.json({ message: 'Accès admin autorisé ✅', isAdmin: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ Exemple de route protégée du dashboard admin
router.get('/dashboard', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    res.json({ message: 'Bienvenue dans le dashboard admin 🔐' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;