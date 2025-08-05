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
    // 🔍 On récupère le profil lié à l'utilisateur
    const profile = await prisma.profile.findUnique({
      where: { userId }
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    const media = await prisma.media.create({
      data: {
        url,
        type,
        isPromoted: isPromoted === true,
        userId,
        profileId: profile.id  // ✅ association au profil
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

// ✅ Récupérer tous les médias publics d’un utilisateur via userId
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const media = await prisma.media.findMany({
      where: { userId: parseInt(userId) },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ media });
  } catch (err) {
    console.error('Erreur lors de la récupération des médias publics :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ Récupérer tous les médias liés à un profil (optionnel)
router.get('/profile/:profileId', async (req, res) => {
  const { profileId } = req.params;

  try {
    const media = await prisma.media.findMany({
      where: { profileId: parseInt(profileId) },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ media });
  } catch (err) {
    console.error('Erreur récupération médias par profil :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;