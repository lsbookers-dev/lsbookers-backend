const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { publicationCreateSchema, commentCreateSchema } = require('../schemas');
const { createNotif, displayName } = require('../services/notifications');

// GET /api/publications/profile/:profileId
router.get('/profile/:profileId', async (req, res) => {
  const profileId = parseInt(req.params.profileId, 10);

  if (isNaN(profileId)) {
    return res.status(400).json({ error: 'Paramètre profileId invalide' });
  }

  try {
    const publications = await prisma.publication.findMany({
      where: { profileId },
      orderBy: { id: 'desc' },
      include: {
        _count: { select: { likes: true, comments: true } },
      },
    });

    return res.json({ publications });
  } catch (error) {
    console.error('❌ Erreur récupération publications :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/publications
router.post('/', requireAuth, validate(publicationCreateSchema), async (req, res) => {
  const { title, media, mediaType, caption, profileId } = req.body;
  const parsedProfileId = parseInt(profileId, 10);

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
        mediaType: mediaType ? String(mediaType).toLowerCase().trim() : 'image',
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

// GET /api/publications/:id/comments — liste des commentaires
router.get('/:id/comments', async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  try {
    const comments = await prisma.publicationComment.findMany({
      where: { publicationId: id },
      orderBy: { createdAt: 'asc' },
      include: {
        profile: {
          select: {
            id: true,
            avatar: true,
            user: { select: { id: true, pseudo: true, firstName: true, lastName: true } },
          },
        },
      },
    })
    return res.json({ comments })
  } catch (err) {
    console.error('❌ Erreur récupération commentaires :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/publications/:id/comments — ajouter un commentaire
router.post('/:id/comments', requireAuth, validate(commentCreateSchema), async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  const { content } = req.body

  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } })
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })

    const comment = await prisma.publicationComment.create({
      data: {
        content: String(content).trim(),
        publicationId: id,
        profileId: profile.id,
      },
      include: {
        profile: {
          select: {
            id: true,
            avatar: true,
            user: { select: { id: true, pseudo: true, firstName: true, lastName: true } },
          },
        },
      },
    })

    // Notification NEW_COMMENT au propriétaire de la publication
    const pub = await prisma.publication.findUnique({
      where: { id },
      include: { profile: { select: { userId: true } } },
    })
    if (pub?.profile?.userId) {
      const commenterName = displayName(comment.profile?.user)
      await createNotif({
        userId:        pub.profile.userId,
        type:          'NEW_COMMENT',
        content:       `${commenterName} a commenté votre publication.`,
        actorId:       req.user.id,
        publicationId: pub.id,
      })
    }

    return res.status(201).json(comment)
  } catch (err) {
    console.error('❌ Erreur ajout commentaire :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// DELETE /api/publications/comments/:id — supprimer un commentaire
router.delete('/comments/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } })
    const comment = await prisma.publicationComment.findUnique({ where: { id } })

    if (!comment) return res.status(404).json({ error: 'Commentaire introuvable' })
    if (!profile || comment.profileId !== profile.id) {
      return res.status(403).json({ error: 'Accès interdit' })
    }

    await prisma.publicationComment.delete({ where: { id } })
    return res.json({ message: 'Commentaire supprimé' })
  } catch (err) {
    console.error('❌ Erreur suppression commentaire :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/publications/:id/like — toggle like
router.post('/:id/like', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } })
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })

    const existing = await prisma.publicationLike.findUnique({
      where: { publicationId_profileId: { publicationId: id, profileId: profile.id } },
    })

    if (existing) {
      await prisma.publicationLike.delete({ where: { id: existing.id } })
    } else {
      await prisma.publicationLike.create({
        data: { publicationId: id, profileId: profile.id },
      })
      // Notification NEW_LIKE — seulement au like, pas au unlike
      const pub = await prisma.publication.findUnique({
        where: { id },
        include: { profile: { select: { userId: true } } },
      })
      if (pub?.profile?.userId) {
        const liker = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { pseudo: true, firstName: true, lastName: true },
        })
        await createNotif({
          userId:        pub.profile.userId,
          type:          'NEW_LIKE',
          content:       `${displayName(liker)} a aimé votre publication.`,
          actorId:       req.user.id,
          publicationId: pub.id,
        })
      }
    }

    const count = await prisma.publicationLike.count({ where: { publicationId: id } })
    return res.json({ liked: !existing, count })
  } catch (err) {
    console.error('❌ Like toggle :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router;