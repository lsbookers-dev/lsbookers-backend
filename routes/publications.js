const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAuth } = require('../middleware/auth');

// GET /api/publications/profile/:profileId
router.get('/profile/:profileId', async (req, res) => {
  const profileId = parseInt(req.params.profileId, 10);

  if (isNaN(profileId)) {
    return res.status(400).json({ error: 'Paramètre profileId invalide' });
  }

  try {
    const publications = await prisma.publication.findMany({
      where: { profileId },
      orderBy: { id: 'desc' }, // Les plus récentes en premier
    });

    return res.json({ publications });
  } catch (error) {
    console.error('❌ Erreur récupération publications :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/publications
router.post('/', requireAuth, async (req, res) => {
  const { title, media, mediaType, caption, profileId } = req.body;
  const parsedProfileId = parseInt(profileId, 10);

  if (!title || !media || !parsedProfileId) {
    return res.status(400).json({ error: 'Données manquantes' });
  }

  try {
    // Vérifie que le profil existe
    const profile = await prisma.profile.findUnique({
      where: { id: parsedProfileId },
      select: {
        id: true,
        userId: true,
      },
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    // Vérifie que le profil appartient bien à l'utilisateur connecté
    if (profile.userId !== req.user.id) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    const newPublication = await prisma.publication.create({
      data: {
        title: String(title).trim(),
        media: String(media).trim(),
        mediaType: mediaType ? String(mediaType).trim() : 'IMAGE',
        caption: caption ? String(caption).trim() : null,
        profileId: parsedProfileId,
      },
    });

    return res.status(201).json(newPublication);
  } catch (error) {
    console.error('❌ Erreur ajout publication :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/publications/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    return res.status(400).json({ error: 'Paramètre id invalide' });
  }

  try {
    // On récupère la publication avec son profil pour vérifier le propriétaire
    const publication = await prisma.publication.findUnique({
      where: { id },
      include: {
        profile: {
          select: {
            id: true,
            userId: true,
          },
        },
      },
    });

    if (!publication) {
      return res.status(404).json({ error: 'Publication introuvable' });
    }

    // Vérifie que la publication appartient bien à l'utilisateur connecté
    if (!publication.profile || publication.profile.userId !== req.user.id) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    await prisma.publication.delete({
      where: { id },
    });

    return res.json({ message: 'Publication supprimée' });
  } catch (error) {
    console.error('❌ Erreur suppression publication :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;