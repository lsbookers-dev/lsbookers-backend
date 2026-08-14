const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { publicationCreateSchema, commentCreateSchema } = require('../schemas');
const { createNotif, displayName } = require('../services/notifications');

// GET /api/publications/:id — récupérer une publication par son ID
router.get('/:id(\\d+)', async (req, res) => {
  const id = Number(req.params.id)
  try {
    const pub = await prisma.publication.findUnique({
      where: { id },
      select: {
        id: true, title: true, media: true, mediaType: true, caption: true,
        _count: { select: { likes: true, comments: true } },
      },
    })
    if (!pub) return res.status(404).json({ error: 'Publication introuvable' })
    return res.json(pub)
  } catch (err) {
    console.error('❌ GET /publications/:id :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

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

// Helper include commentaire
const COMMENT_INCLUDE = {
  profile: {
    select: {
      id: true, avatar: true,
      user: { select: { id: true, pseudo: true, firstName: true, lastName: true } },
    },
  },
  _count: { select: { likes: true, replies: true } },
}

// GET /api/publications/:id/comments — liste des commentaires (top-level + replies)
router.get('/:id/comments', async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  // profileId optionnel pour savoir si le viewer a liké
  const viewerProfileId = req.query.profileId ? parseInt(req.query.profileId, 10) : null

  try {
    const comments = await prisma.publicationComment.findMany({
      where: { publicationId: id, parentId: null }, // top-level seulement
      orderBy: { createdAt: 'asc' },
      include: {
        ...COMMENT_INCLUDE,
        replies: {
          orderBy: { createdAt: 'asc' },
          include: {
            ...COMMENT_INCLUDE,
            ...(viewerProfileId ? {
              likes: { where: { profileId: viewerProfileId }, select: { id: true } }
            } : {}),
          },
        },
        ...(viewerProfileId ? {
          likes: { where: { profileId: viewerProfileId }, select: { id: true } }
        } : {}),
      },
    })

    const format = (c) => ({
      ...c,
      likedByMe: viewerProfileId ? (c.likes?.length > 0) : false,
      likes: undefined,
    })

    return res.json({ comments: comments.map(c => ({
      ...format(c),
      replies: c.replies.map(format),
    })) })
  } catch (err) {
    console.error('❌ Erreur récupération commentaires :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/publications/:id/comments — ajouter un commentaire ou une réponse
router.post('/:id/comments', requireAuth, validate(commentCreateSchema), async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  const { content, parentId } = req.body

  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } })
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })

    const comment = await prisma.publicationComment.create({
      data: {
        content:       String(content).trim(),
        publicationId: id,
        profileId:     profile.id,
        ...(parentId ? { parentId: parseInt(parentId, 10) } : {}),
      },
      include: {
        ...COMMENT_INCLUDE,
        replies: { include: COMMENT_INCLUDE },
      },
    })

    const commenterName = displayName(comment.profile?.user)

    if (parentId) {
      // Réponse → notifier l'auteur du commentaire parent
      const parent = await prisma.publicationComment.findUnique({
        where: { id: parseInt(parentId, 10) },
        include: { profile: { select: { userId: true } } },
      })
      if (parent?.profile?.userId) {
        await createNotif({
          userId:  parent.profile.userId,
          type:    'NEW_COMMENT_REPLY',
          content: `${commenterName} a répondu à votre commentaire.`,
          actorId: req.user.id,
          publicationId: id,
        })
      }
    } else {
      // Commentaire → notifier le propriétaire de la publication
      const pub = await prisma.publication.findUnique({
        where: { id },
        include: { profile: { select: { userId: true } } },
      })
      if (pub?.profile?.userId) {
        await createNotif({
          userId:        pub.profile.userId,
          type:          'NEW_COMMENT',
          content:       `${commenterName} a commenté votre publication.`,
          actorId:       req.user.id,
          publicationId: pub.id,
        })
      }
    }

    return res.status(201).json({ ...comment, likedByMe: false })
  } catch (err) {
    console.error('❌ Erreur ajout commentaire :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/publications/comments/:id/like — toggle like sur un commentaire
router.post('/comments/:id/like', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } })
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })

    const existing = await prisma.publicationCommentLike.findUnique({
      where: { commentId_profileId: { commentId: id, profileId: profile.id } },
    })

    if (existing) {
      await prisma.publicationCommentLike.delete({
        where: { commentId_profileId: { commentId: id, profileId: profile.id } },
      })
    } else {
      await prisma.publicationCommentLike.create({
        data: { commentId: id, profileId: profile.id },
      })
      // Notifier l'auteur du commentaire
      const comment = await prisma.publicationComment.findUnique({
        where: { id },
        include: { profile: { select: { userId: true } } },
      })
      if (comment?.profile?.userId) {
        const liker = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { pseudo: true, firstName: true, lastName: true },
        })
        await createNotif({
          userId:        comment.profile.userId,
          type:          'NEW_COMMENT_LIKE',
          content:       `${displayName(liker)} a aimé votre commentaire.`,
          actorId:       req.user.id,
          publicationId: comment.publicationId,
        })
      }
    }

    const count = await prisma.publicationCommentLike.count({ where: { commentId: id } })
    return res.json({ liked: !existing, count })
  } catch (err) {
    console.error('❌ Erreur like commentaire :', err)
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