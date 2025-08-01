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
    const follow = await prisma.follower.create({
      data: {
        followerId,
        followedId
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
    const followings = await prisma.follower.findMany({
      where: { followerId: req.user.id },
      include: { followed: { include: { user: true } } }
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
    const followers = await prisma.follower.findMany({
      where: { followedId: req.user.id },
      include: { follower: { include: { user: true } } }
    });
    res.json({ followers });
  } catch (error) {
    console.error('Erreur récupération followers :', error);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

module.exports = router;