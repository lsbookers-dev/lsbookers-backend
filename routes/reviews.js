// routes/reviews.js
const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/reviews/profile/:profileId
 * Public : liste des avis reçus par un profil
 */
router.get('/profile/:profileId', async (req, res) => {
  const profileId = Number.parseInt(req.params.profileId, 10);
  if (Number.isNaN(profileId)) {
    return res.status(400).json({ error: 'Paramètre profileId invalide' });
  }

  try {
    const reviews = await prisma.review.findMany({
      where: { targetId: profileId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        author: {
          select: {
            avatar: true,
            user: { select: { pseudo: true, firstName: true, lastName: true } },
          },
        },
      },
    });

    return res.json({ reviews });
  } catch (error) {
    console.error('❌ Erreur récupération avis :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /api/reviews
 * Privé : laisser un avis sur un profil
 */
router.post('/', requireAuth, async (req, res) => {
  const { targetId, rating, comment, eventId } = req.body;
  const userId = req.user.id;

  if (!targetId || !rating) {
    return res.status(400).json({ error: 'targetId et rating sont requis' });
  }

  const parsedRating = Number.parseInt(rating, 10);
  if (parsedRating < 1 || parsedRating > 5) {
    return res.status(400).json({ error: 'La note doit être entre 1 et 5' });
  }

  try {
    // Récupérer le profil de l'auteur
    const authorProfile = await prisma.profile.findUnique({ where: { userId } });
    if (!authorProfile) {
      return res.status(404).json({ error: 'Profil auteur introuvable' });
    }

    const review = await prisma.review.create({
      data: {
        authorId: authorProfile.id,
        targetId: Number.parseInt(targetId, 10),
        rating: parsedRating,
        comment: comment?.trim() || null,
        eventId: eventId ? Number.parseInt(eventId, 10) : null,
      },
    });

    return res.status(201).json({ review });
  } catch (error) {
    // Doublon (unique constraint)
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Vous avez déjà laissé un avis pour cet événement' });
    }
    console.error('❌ Erreur création avis :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
