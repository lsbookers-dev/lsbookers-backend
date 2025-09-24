const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticateToken = require('../middleware/authenticate');

// Suivre un utilisateur
router.post('/:id', authenticateToken, async (req, res) => {
  const followerId = req.user.id;
  const followedId = parseInt(req.params.id);

  if (followerId === followedId) {
    return res.status(400).json({ error: 'Impossible de se suivre soi-même ❌' });
  }

  try {
    // Créer la relation de suivi
    const follow = await prisma.follow.create({
      data: {
        followerId,
        followingId: followedId
      }
    });

    // Créer une notification pour l'utilisateur suivi
    const follower = await prisma.user.findUnique({
      where: { id: followerId },
      select: { name: true }
    });
    await prisma.notification.create({
      data: {
        userId: followedId,
        type: 'NEW_FOLLOWER',
        message: `Vous avez un nouvel abonné : ${follower?.name || 'Utilisateur'}`,
        read: false
      }
    });

    res.json({ message: 'Abonnement réussi ✅', follow });
  } catch (error) {
    console.error('Erreur abonnement :', error);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

// Voir les utilisateurs que je suis
router.get('/following', authenticateToken, async (req, res) => {
  try {
    const followings = await prisma.follow.findMany({
      where: { followerId: req.user.id },
      include: { following: { include: { user: true } } }
    });
    res.json({ following: followings });
  } catch (error) {
    console.error('Erreur récupération following :', error);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

// Voir mes abonnés
router.get('/followers', authenticateToken, async (req, res) => {
  try {
    const followers = await prisma.follow.findMany({
      where: { followingId: req.user.id },
      include: { follower: { include: { user: true } } }
    });
    res.json({ followers });
  } catch (error) {
    console.error('Erreur récupération followers :', error);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

module.exports = router;