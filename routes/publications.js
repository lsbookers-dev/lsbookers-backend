const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticate = require('../middleware/authenticate');

// GET /api/publications/profile/:profileId
router.get('/profile/:profileId', async (req, res) => {
  const profileId = parseInt(req.params.profileId);
  if (isNaN(profileId)) {
    return res.status(400).json({ error: 'Paramètre profileId invalide' });
  }

  try {
    const publications = await prisma.publication.findMany({
      where: { profileId },
      orderBy: { id: 'desc' }, // Les plus récentes en premier
    });
    res.json({ publications });
  } catch (error) {
    console.error('❌ Erreur récupération publications:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/publications
router.post('/', authenticate, async (req, res) => {
  const { title, media, mediaType, caption, profileId } = req.body;
  if (!title || !media || !profileId) {
    return res.status(400).json({ error: 'Données manquantes' });
  }

  try {
    const newPublication = await prisma.publication.create({
      data: {
        title,
        media,
        mediaType,
        caption,
        profileId: parseInt(profileId),
      },
    });
    res.json(newPublication);
  } catch (error) {
    console.error('❌ Erreur ajout publication:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/publications/:id
router.delete('/:id', authenticate, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Paramètre id invalide' });
  }

  try {
    await prisma.publication.delete({
      where: { id },
    });
    res.json({ message: 'Publication supprimée' });
  } catch (error) {
    console.error('❌ Erreur suppression publication:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;