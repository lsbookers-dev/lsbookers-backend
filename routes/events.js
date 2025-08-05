const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticate = require('../middleware/authenticate');

// ✅ Ajouter un événement
router.post('/', authenticate, async (req, res) => {
  const { title, start, end, allDay, lieu, type, profileId } = req.body;

  if (!title || !start || !profileId) {
    return res.status(400).json({ error: 'Champs requis manquants' });
  }

  try {
    const event = await prisma.event.create({
      data: {
        title,
        start: new Date(start),
        end: end ? new Date(end) : null,
        allDay: allDay || false,
        lieu,
        type,
        profileId: parseInt(profileId),
      }
    });

    res.status(201).json({ message: 'Événement créé ✅', event });
  } catch (err) {
    console.error('❌ Erreur création événement :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ Supprimer un événement
router.delete('/:eventId', authenticate, async (req, res) => {
  const { eventId } = req.params;

  try {
    await prisma.event.delete({
      where: { id: parseInt(eventId) }
    });

    res.json({ message: 'Événement supprimé ✅' });
  } catch (err) {
    console.error('❌ Erreur suppression événement :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ Récupérer les événements d’un profil
router.get('/profile/:profileId', async (req, res) => {
  const { profileId } = req.params;

  try {
    const events = await prisma.event.findMany({
      where: { profileId: parseInt(profileId) },
      orderBy: { start: 'asc' }
    });

    res.json({ events });
  } catch (err) {
    console.error('❌ Erreur récupération événements :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;