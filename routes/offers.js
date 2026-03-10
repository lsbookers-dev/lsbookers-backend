const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const verifyToken = require('../middleware/verifyToken');

// 📌 Créer une nouvelle offre
router.post('/', verifyToken, async (req, res) => {
  const { title, description, type, specialty, date, location, country, radiusKm } = req.body;

  // Vérification des champs obligatoires
  if (!title || !description || !type || !date || !location || !country) {
    return res.status(400).json({ error: 'CHAMPS_OBLIGATOIRES_MANQUANTS' });
  }

  try {
    // Vérifier que l’utilisateur est ORGANIZER
    if (req.user.role !== 'ORGANIZER') {
      return res.status(403).json({ error: 'ACCÈS_REFUSÉ (réservé aux organisateurs)' });
    }

    const profile = await prisma.profile.findUnique({
      where: { userId: req.user.id },
    });

    if (!profile) {
      return res.status(404).json({ error: 'PROFILE_INTROUVABLE' });
    }

    // Validation du type
    if (!['ARTIST', 'PROVIDER', 'ALL'].includes(type)) {
      return res.status(400).json({ error: 'TYPE_INVALIDE' });
    }

    // Validation de la date
    const offerDate = new Date(date);
    if (isNaN(offerDate.getTime()) || offerDate <= new Date()) {
      return res.status(400).json({ error: 'DATE_INVALIDE_OU_PASSE' });
    }

    // Création de l’offre
    const offer = await prisma.offer.create({
      data: {
        title: String(title).trim(),
        description: String(description).trim(),
        type,
        specialty: specialty ? String(specialty).trim() : null,
        date: offerDate,
        location: String(location).trim(),
        country: String(country).trim(),
        radiusKm: radiusKm ? parseInt(radiusKm, 10) : null,
        status: 'ACTIVE',
        organizer: { connect: { id: profile.id } },
      },
    });

    // Récupération des utilisateurs potentiellement concernés
    const users = await prisma.user.findMany({
      where: {
        role: {
          in: type === 'ALL' ? ['ARTIST', 'PROVIDER'] : [type],
        },
        profile: {
          specialties: specialty ? { hasSome: [specialty] } : undefined,
          notificationPreferences: {
            locationScope: {
              in: ['INTERNATIONAL'],
            },
          },
        },
      },
      include: { profile: true },
    });

    // Création des notifications
    for (const user of users) {
      await prisma.notification.create({
        data: {
          userId: user.id,
          type: 'NEW_OFFER',
          content: `Nouvelle offre : ${title} par ${req.user.name || 'Un organisateur'}`,
          read: false,
          offerId: offer.id,
          actorId: req.user.id,
        },
      });
    }

    return res.status(201).json(offer);
  } catch (error) {
    console.error('Erreur création offre :', error);
    return res.status(500).json({ error: 'ERREUR_SERVEUR' });
  }
});

// 📌 Lister les offres avec filtres
router.get('/', async (req, res) => {
  const { type, location, country, organizerId } = req.query;

  try {
    const where = {
      status: 'ACTIVE',
    };

    if (type && ['ARTIST', 'PROVIDER', 'ALL'].includes(type)) {
      where.type = type;
    }

    if (location) {
      where.location = {
        contains: location,
        mode: 'insensitive',
      };
    }

    if (country) {
      where.country = {
        contains: country,
        mode: 'insensitive',
      };
    }

    if (organizerId) {
      where.organizerId = parseInt(organizerId, 10);
    }

    const offers = await prisma.offer.findMany({
      where,
      include: {
        organizer: {
          include: {
            user: {
              select: { name: true },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return res.status(200).json(offers);
  } catch (error) {
    console.error('Erreur récupération offres :', error);
    return res.status(500).json({ error: 'ERREUR_SERVEUR' });
  }
});

// 📌 Récupérer une offre spécifique par ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const offer = await prisma.offer.findUnique({
      where: { id: parseInt(id, 10) },
      include: {
        organizer: {
          include: {
            user: {
              select: { name: true },
            },
          },
        },
      },
    });

    if (!offer || offer.status !== 'ACTIVE') {
      return res.status(404).json({ error: 'OFFRE_INTROUVABLE_OU_FERMEE' });
    }

    return res.status(200).json(offer);
  } catch (error) {
    console.error('Erreur récupération offre :', error);
    return res.status(500).json({ error: 'ERREUR_SERVEUR' });
  }
});

// 📌 Supprimer une offre
router.delete('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Vérifier que l’utilisateur est ORGANIZER
    if (req.user.role !== 'ORGANIZER') {
      return res.status(403).json({ error: 'ACCÈS_REFUSÉ (réservé aux organisateurs)' });
    }

    const profile = await prisma.profile.findUnique({
      where: { userId: req.user.id },
    });

    if (!profile) {
      return res.status(404).json({ error: 'PROFILE_INTROUVABLE' });
    }

    const offer = await prisma.offer.findUnique({
      where: { id: parseInt(id, 10) },
    });

    if (!offer) {
      return res.status(404).json({ error: 'OFFRE_INTROUVABLE' });
    }

    if (offer.organizerId !== profile.id) {
      return res.status(403).json({
        error: 'ACCÈS_REFUSÉ (non autorisé à supprimer cette offre)',
      });
    }

    await prisma.offer.delete({
      where: { id: parseInt(id, 10) },
    });

    return res.status(204).json({});
  } catch (error) {
    console.error('Erreur suppression offre :', error);
    return res.status(500).json({ error: 'ERREUR_SERVEUR' });
  }
});

module.exports = router;