const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { isBlockedBetween, getBlockedUserIds, getBlockedProfileIds } = require('../lib/blocks');
const { isOwnMediaUrl } = require('../lib/mediaUrl');
const { validate } = require('../middleware/validate');
const { publicationCreateSchema, commentCreateSchema } = require('../schemas');
const { createNotif, displayName } = require('../services/notifications');
const { deleteR2Object } = require('../lib/r2');

// Helper — include médias additionnels
const MEDIA_INCLUDE = {
  additionalMedia: { orderBy: { order: 'asc' }, select: { id: true, url: true, mediaType: true, order: true } },
}

// Helper — include tags acceptés (pour affichage)
const TAG_INCLUDE = {
  tags: {
    where: { status: 'ACCEPTED' },
    select: {
      id: true,
      status: true,
      taggedUser: {
        select: {
          id: true, pseudo: true, firstName: true, lastName: true,
          profile: { select: { id: true, avatar: true } },
        },
      },
    },
  },
}

// Helper — include tous les tags (pour le propriétaire qui veut voir PENDING aussi)
const TAG_INCLUDE_ALL = {
  tags: {
    select: {
      id: true,
      status: true,
      taggedUser: {
        select: {
          id: true, pseudo: true, firstName: true, lastName: true,
          profile: { select: { id: true, avatar: true } },
        },
      },
    },
  },
}

// GET /api/publications/:id — récupérer une publication par son ID (tous les tags, PENDING inclus)
// Les identifications en attente / refusées ne sont visibles que par l'auteur et la personne identifiée.
router.get('/:id(\\d+)', optionalAuth, async (req, res) => {
  const id = Number(req.params.id)
  const viewerId = req.user?.id
  try {
    const pub = await prisma.publication.findUnique({
      where: { id },
      include: {
        ...MEDIA_INCLUDE,
        ...TAG_INCLUDE_ALL,
        profile: { select: { userId: true } },
        _count: { select: { likes: true, comments: true } },
      },
    })
    if (!pub) return res.status(404).json({ error: 'Publication introuvable' })
    const authorId = pub.profile?.userId
    if (viewerId && await isBlockedBetween(viewerId, authorId)) {
      return res.status(404).json({ error: 'Publication introuvable' })
    }
    const isAuthor = !!viewerId && viewerId === authorId
    const { profile, ...rest } = pub
    return res.json({
      ...rest,
      tags: pub.tags.filter(t => t.status === 'ACCEPTED' || isAuthor || t.taggedUser?.id === viewerId),
    })
  } catch (err) {
    console.error('❌ GET /publications/:id :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// GET /api/publications/profile/:profileId?page=1&limit=20
router.get('/profile/:profileId', optionalAuth, async (req, res) => {
  const profileId = parseInt(req.params.profileId, 10);
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

  if (isNaN(profileId)) {
    return res.status(400).json({ error: 'Paramètre profileId invalide' });
  }

  try {
    // Blocage (dans un sens ou l'autre) : aucune publication visible
    if (req.user) {
      const blockedProfileIds = await getBlockedProfileIds(req.user.id);
      if (blockedProfileIds.includes(profileId)) {
        return res.json({ publications: [], total: 0, page, limit, hasMore: false });
      }
    }

    const [publications, total] = await Promise.all([
      prisma.publication.findMany({
        where:   { profileId },
        orderBy: { createdAt: 'desc' },
        skip:    (page - 1) * limit,
        take:    limit,
        include: {
          ...MEDIA_INCLUDE,
          ...TAG_INCLUDE,
          _count: { select: { likes: true, comments: true } },
        },
      }),
      prisma.publication.count({ where: { profileId } }),
    ]);

    return res.json({
      publications,
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (error) {
    console.error('❌ Erreur récupération publications :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/publications
router.post('/', requireAuth, validate(publicationCreateSchema), async (req, res) => {
  const { title, media, mediaType, caption, profileId, additionalMedia } = req.body;
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

    // Validation URL média principal (doit provenir de notre bucket R2)
    if (!isOwnMediaUrl(String(media))) {
      return res.status(400).json({ error: 'URL média invalide' });
    }

    // Validation URLs médias additionnels
    if (Array.isArray(additionalMedia)) {
      for (const m of additionalMedia) {
        if (!isOwnMediaUrl(String(m?.url))) {
          return res.status(400).json({ error: 'URL média additionnel invalide' });
        }
      }
    }

    const newPublication = await prisma.publication.create({
      data: {
        title: String(title).trim(),
        media: String(media).trim(),
        mediaType: mediaType ? String(mediaType).toLowerCase().trim() : 'image',
        caption: caption ? String(caption).trim() : null,
        profileId: parsedProfileId,
        // Médias additionnels (multi-upload)
        ...(Array.isArray(additionalMedia) && additionalMedia.length > 0 ? {
          additionalMedia: {
            create: additionalMedia.map((m, i) => ({
              url:       String(m.url).trim(),
              mediaType: m.mediaType ? String(m.mediaType).toLowerCase().trim() : 'image',
              order:     i,
            })),
          },
        } : {}),
      },
      include: MEDIA_INCLUDE,
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
    // On récupère la publication avec son profil + médias pour vérifier le propriétaire et nettoyer R2
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
      // Note : `media` est un champ scalaire (String), il est toujours inclus
    });

    if (!publication) {
      return res.status(404).json({ error: 'Publication introuvable' });
    }

    // Vérifie que la publication appartient bien à l'utilisateur connecté
    if (!publication.profile || publication.profile.userId !== req.user.id) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    // Supprimer les fichiers R2 (média principal + médias additionnels)
    const additionalMediaToDelete = await prisma.publicationMedia.findMany({
      where: { publicationId: id },
      select: { url: true },
    });
    await Promise.all([
      deleteR2Object(publication.media),
      ...additionalMediaToDelete.map(m => deleteR2Object(m.url)),
    ]);

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
router.get('/:id/comments', optionalAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  // profileId optionnel pour savoir si le viewer a liké
  const viewerProfileId = req.query.profileId ? parseInt(req.query.profileId, 10) : null

  try {
    // Commentaires des utilisateurs bloqués (dans un sens ou l'autre) masqués
    const blockedProfileIds = req.user ? await getBlockedProfileIds(req.user.id) : []
    const notBlocked = blockedProfileIds.length ? { profileId: { notIn: blockedProfileIds } } : {}

    const comments = await prisma.publicationComment.findMany({
      where: { publicationId: id, parentId: null, ...notBlocked }, // top-level seulement
      orderBy: { createdAt: 'asc' },
      include: {
        ...COMMENT_INCLUDE,
        replies: {
          where: notBlocked,
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

    const target = await prisma.publication.findUnique({
      where: { id },
      select: { profile: { select: { userId: true } } },
    })
    if (!target) return res.status(404).json({ error: 'Publication introuvable' })
    if (await isBlockedBetween(req.user.id, target.profile?.userId)) {
      return res.status(403).json({ error: 'BLOCKED' })
    }

    // P7b — Vérifier que le commentaire parent appartient bien à la même publication
    const parsedParentId = parentId ? parseInt(parentId, 10) : null
    if (parsedParentId) {
      const parentComment = await prisma.publicationComment.findUnique({
        where: { id: parsedParentId },
        select: { publicationId: true, parentId: true, profile: { select: { userId: true } } },
      })
      if (!parentComment) return res.status(404).json({ error: 'Commentaire parent introuvable' })
      if (await isBlockedBetween(req.user.id, parentComment.profile?.userId)) {
        return res.status(403).json({ error: 'BLOCKED' })
      }
      if (parentComment.publicationId !== id) return res.status(400).json({ error: 'Commentaire parent hors de cette publication' })
      // Pas de réponse à une réponse (max 2 niveaux)
      if (parentComment.parentId !== null) return res.status(400).json({ error: 'Les réponses imbriquées ne sont pas supportées' })
    }

    const comment = await prisma.publicationComment.create({
      data: {
        content:       String(content).trim(),
        publicationId: id,
        profileId:     profile.id,
        ...(parsedParentId ? { parentId: parsedParentId } : {}),
      },
      include: {
        ...COMMENT_INCLUDE,
        replies: { include: COMMENT_INCLUDE },
      },
    })

    const commenterName = displayName(comment.profile?.user)

    if (parsedParentId) {
      // Réponse → notifier l'auteur du commentaire parent
      const parent = await prisma.publicationComment.findUnique({
        where: { id: parsedParentId },
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

    if (!existing) {
      const target = await prisma.publicationComment.findUnique({
        where: { id },
        select: { profile: { select: { userId: true } } },
      })
      if (!target) return res.status(404).json({ error: 'Commentaire introuvable' })
      if (await isBlockedBetween(req.user.id, target.profile?.userId)) {
        return res.status(403).json({ error: 'BLOCKED' })
      }
    }

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

    if (!existing) {
      const target = await prisma.publication.findUnique({
        where: { id },
        select: { profile: { select: { userId: true } } },
      })
      if (!target) return res.status(404).json({ error: 'Publication introuvable' })
      if (await isBlockedBetween(req.user.id, target.profile?.userId)) {
        return res.status(403).json({ error: 'BLOCKED' })
      }
    }

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

// ─────────────────────────────────────────────
//  TAGS
// ─────────────────────────────────────────────

// GET /api/publications/:id/tags — liste des tags d'une publication
router.get('/:id/tags', async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })
  try {
    const tags = await prisma.publicationTag.findMany({
      where: { publicationId: id, status: 'ACCEPTED' },
      select: {
        id: true, status: true,
        taggedUser: {
          select: {
            id: true, pseudo: true, firstName: true, lastName: true,
            profile: { select: { id: true, avatar: true } },
          },
        },
      },
    })
    return res.json({ tags })
  } catch (err) {
    console.error('❌ GET tags :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/publications/:id/tags — taguer des utilisateurs (auteur seulement, max 5)
router.post('/:id/tags', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  const { userIds } = req.body // tableau d'IDs utilisateurs à taguer
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'userIds requis (tableau)' })
  }

  try {
    const myProfile = await prisma.profile.findUnique({ where: { userId: req.user.id } })
    if (!myProfile) return res.status(404).json({ error: 'Profil introuvable' })

    const pub = await prisma.publication.findUnique({
      where: { id },
      include: {
        profile: { select: { userId: true } },
        tags: { select: { id: true } },
      },
    })
    if (!pub) return res.status(404).json({ error: 'Publication introuvable' })
    if (pub.profile.userId !== req.user.id) return res.status(403).json({ error: 'Accès interdit' })

    // Max 5 tags au total
    const existingCount = pub.tags.length
    const toAdd = userIds.slice(0, Math.max(0, 5 - existingCount))
    if (toAdd.length === 0) return res.status(400).json({ error: 'Maximum 5 tags par publication' })

    // Créer les tags (ignorer les doublons et les utilisateurs bloqués)
    const blockedUserIds = await getBlockedUserIds(req.user.id)
    const created = []
    for (const uid of toAdd) {
      const userId = parseInt(uid, 10)
      if (isNaN(userId) || userId === req.user.id || blockedUserIds.includes(userId)) continue
      try {
        const tag = await prisma.publicationTag.create({
          data: { publicationId: id, taggedUserId: userId, taggedByUserId: req.user.id },
          include: {
            taggedUser: {
              select: {
                id: true, pseudo: true, firstName: true, lastName: true,
                profile: { select: { id: true, avatar: true } },
              },
            },
          },
        })
        created.push(tag)

        // Notifier l'utilisateur tagué
        const tagger = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { pseudo: true, firstName: true, lastName: true },
        })
        await createNotif({
          userId:        userId,
          type:          'TAG_ON_PUBLICATION',
          content:       `${displayName(tagger)} t'a identifié(e) dans une publication.`,
          actorId:       req.user.id,
          publicationId: id,
        }).catch(() => {})
      } catch {
        // Doublon ignoré
      }
    }

    return res.status(201).json({ tags: created })
  } catch (err) {
    console.error('❌ POST tags :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/publications/:id/tags/:tagId/respond — accepter ou refuser un tag
router.post('/:id/tags/:tagId/respond', requireAuth, async (req, res) => {
  const publicationId = parseInt(req.params.id, 10)
  const tagId         = parseInt(req.params.tagId, 10)
  const { action }    = req.body // 'accept' | 'decline'

  if (isNaN(publicationId) || isNaN(tagId)) return res.status(400).json({ error: 'ID invalide' })
  if (!['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'action invalide (accept|decline)' })

  try {
    const tag = await prisma.publicationTag.findUnique({ where: { id: tagId } })
    if (!tag) return res.status(404).json({ error: 'Tag introuvable' })
    if (tag.taggedUserId !== req.user.id) return res.status(403).json({ error: 'Accès interdit' })
    if (tag.publicationId !== publicationId) return res.status(400).json({ error: 'Tag ne correspond pas à la publication' })

    const newStatus = action === 'accept' ? 'ACCEPTED' : 'DECLINED'
    const updated = await prisma.publicationTag.update({
      where: { id: tagId },
      data:  { status: newStatus },
      include: {
        taggedUser: {
          select: {
            id: true, pseudo: true, firstName: true, lastName: true,
            profile: { select: { id: true, avatar: true } },
          },
        },
      },
    })

    return res.json({ tag: updated })
  } catch (err) {
    console.error('❌ POST respond tag :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// DELETE /api/publications/:id/tags/:tagId — supprimer un tag (auteur de la pub ou utilisateur tagué)
router.delete('/:id/tags/:tagId', requireAuth, async (req, res) => {
  const publicationId = parseInt(req.params.id, 10)
  const tagId         = parseInt(req.params.tagId, 10)
  if (isNaN(publicationId) || isNaN(tagId)) return res.status(400).json({ error: 'ID invalide' })

  try {
    const tag = await prisma.publicationTag.findUnique({
      where: { id: tagId },
      include: { publication: { include: { profile: { select: { userId: true } } } } },
    })
    if (!tag) return res.status(404).json({ error: 'Tag introuvable' })

    const isAuthor = tag.publication.profile.userId === req.user.id
    const isTagged = tag.taggedUserId === req.user.id
    if (!isAuthor && !isTagged) return res.status(403).json({ error: 'Accès interdit' })

    await prisma.publicationTag.delete({ where: { id: tagId } })
    return res.json({ message: 'Tag supprimé' })
  } catch (err) {
    console.error('❌ DELETE tag :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// GET /api/publications/tagged/:profileId — publications où un profil est identifié (ACCEPTED, public)
router.get('/tagged/:profileId', optionalAuth, async (req, res) => {
  const profileId = parseInt(req.params.profileId, 10)
  if (!profileId) return res.status(400).json({ error: 'profileId invalide' })
  try {
    // Récupérer le userId depuis le profil
    const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { userId: true } })
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })

    const blockedProfileIds = req.user ? await getBlockedProfileIds(req.user.id) : []
    if (req.user && (await getBlockedUserIds(req.user.id)).includes(profile.userId)) {
      return res.json({ publications: [] })
    }

    const tags = await prisma.publicationTag.findMany({
      where: {
        taggedUserId: profile.userId,
        status: 'ACCEPTED',
        ...(blockedProfileIds.length ? { publication: { profileId: { notIn: blockedProfileIds } } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        publication: {
          include: {
            ...MEDIA_INCLUDE,
            ...TAG_INCLUDE,
            _count: { select: { likes: true, comments: true } },
          },
        },
      },
    })
    return res.json({ publications: tags.map(t => t.publication).filter(Boolean) })
  } catch (err) {
    console.error('❌ GET tagged/:profileId :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// GET /api/publications/my-tags — publications où je suis tagué (PENDING pour répondre)
router.get('/my-tags', requireAuth, async (req, res) => {
  try {
    const tags = await prisma.publicationTag.findMany({
      where: { taggedUserId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        publication: {
          include: {
            ...MEDIA_INCLUDE,
            profile: {
              select: {
                id: true, avatar: true,
                user: { select: { id: true, pseudo: true, firstName: true, lastName: true } },
              },
            },
            _count: { select: { likes: true, comments: true } },
          },
        },
      },
    })
    return res.json({ tags })
  } catch (err) {
    console.error('❌ GET my-tags :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router;