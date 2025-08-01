const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const authenticate = require('../middleware/authenticate');
const prisma = new PrismaClient();

// Route : GET /api/feed
router.get('/', authenticate, async (req, res) => {
  const userId = req.user.id;

  try {
    // Récupérer le profil connecté
    const profile = await prisma.profile.findUnique({
      where: { userId },
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profil non trouvé ❌' });
    }

    // Récupérer les ID des profils suivis
    const following = await prisma.follower.findMany({
      where: { followerId: profile.id },
      select: { followedId: true },
    });

    const followedProfileIds = following.map((f) => f.followedId);

    // Rechercher les publications :
    const media = await prisma.media.findMany({
      where: {
        OR: [
          { profileId: { in: followedProfileIds } },   // Publications des followés
          { isPromoted: true },                         // Publications sponsorisées
        ],
      },
      include: {
        profile: {
          include: {
            user: {
              select: { name: true, email: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ feed: media });
  } catch (error) {
    console.error('Erreur lors de la récupération du feed :', error);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

module.exports = router;