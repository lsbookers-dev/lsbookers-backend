const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticate = require('../middleware/authenticate');

// ✅ Ajouter un média (photo ou vidéo)
router.post('/', authenticate, async (req, res) => {
  const { url, type, isPromoted } = req.body;
  const userId = req.user.id;

  try {
    const media = await prisma.media.create({
      data: {
        url,
        type,
        isPromoted: isPromoted === true,
        userId: userId // ✅ on lie le média directement à l'utilisateur
      }
    });

    res.json({ message: 'Média ajouté ✅', media });
  } catch (error) {
    console.error('Erreur lors de l’ajout du média :', error);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

// ✅ Récupérer tous les médias de l’utilisateur connecté
router.get('/my', authenticate, async (req, res) => {
  const userId = req.user.id;

  try {
    const media = await prisma.media.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ media });
  } catch (error) {
    console.error('Erreur lors de la récupération des médias :', error);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

// ✅ Récupérer tous les médias d’un utilisateur public via userId
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const media = await prisma.media.findMany({
      where: { userId: parseInt(userId) }, // ✅ correction ici
      orderBy: { createdAt: 'desc' }
    });

    res.json({ media });
  } catch (err) {
    console.error('Erreur lors de la récupération des médias publics :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;