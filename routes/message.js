const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { conversationCreateSchema } = require('../schemas')
const multer = require('multer')
const { put } = require('@vercel/blob')
const { createNotif, displayName } = require('../services/notifications')

/* ─── Whitelist MIME pour les fichiers messages ─── */
const MSG_ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/quicktime', 'video/webm',
  'application/pdf',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
])

const msgFileFilter = (req, file, cb) => {
  if (MSG_ALLOWED_MIME.has(file.mimetype)) return cb(null, true)
  return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'FORMAT_NOT_ALLOWED'))
}

/* ─── Vérification magic bytes pour les images (anti-spoofing) ─── */
function isMsgImageValid(buf, mimetype) {
  if (!mimetype.startsWith('image/')) return true // vidéos/pdf/audio : on fait confiance au fileFilter
  if (buf.length < 12) return false
  if (mimetype === 'image/jpeg')
    return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF
  if (mimetype === 'image/png')
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
  if (mimetype === 'image/gif')
    return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46
  if (mimetype === 'image/webp')
    return buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
           buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  return false
}

/* ─── Multer mémoire sécurisé ─── */
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: msgFileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 Mo max
})

/* ─── Helpers ─────────────────────────────────────── */
function getUserDisplayName(u) {
  if (!u) return 'Utilisateur'
  return u.pseudo || [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Utilisateur'
}

function pickUserPublic(u) {
  if (!u) return null
  return {
    id: u.id,
    name: getUserDisplayName(u),
    pseudo: u.pseudo || null,
    firstName: u.firstName || null,
    lastName: u.lastName || null,
    role: u.role,
    profile: u.profile ? { avatar: u.profile.avatar || null } : null,
    profileId: u.profile?.id || null,
    lastActiveAt: u.lastActiveAt || null,
  }
}

const isAdminUser = (u) => !!u && String(u.role).toUpperCase() === 'ADMIN'

function detectAttachmentType(mimetype) {
  if (!mimetype) return 'DOCUMENT'
  if (mimetype.startsWith('image/')) return 'IMAGE'
  if (mimetype.startsWith('video/')) return 'VIDEO'
  return 'DOCUMENT'
}

/* Upload vers Vercel Blob depuis un buffer en mémoire */
async function uploadBufferToBlob(buffer, mimetype, originalname) {
  const safeName = (originalname || 'file').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '')
  const filename = `lsbookers/messages/${Date.now()}-${safeName}`
  const blob = await put(filename, buffer, {
    access: 'public',
    contentType: mimetype,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  })
  return { secure_url: blob.url, resource_type: detectAttachmentType(mimetype).toLowerCase() }
}

/* =========================================================
   GET /api/messages/conversations
========================================================= */
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    // Mettre à jour lastActiveAt
    prisma.user.update({ where: { id: userId }, data: { lastActiveAt: new Date() } }).catch(() => {})

    const participations = await prisma.conversationParticipant.findMany({
      where: { userId },
      include: {
        conversation: {
          include: {
            participants: {
              include: { user: { include: { profile: true } } },
            },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    })

    // Fix 1 : ne montrer que les conversations avec au moins 1 message
    // (évite qu'une conversation vide apparaisse chez le destinataire)
    const withMessages = participations.filter(
      (p) => p.conversation.messages.length > 0
    )

    const conversations = await Promise.all(
      withMessages.map(async (p) => {
        const c = p.conversation
        const lastMessage = c.messages[0] || null

        // Construire la liste des participants
        let participants = c.participants.map((part) => pickUserPublic(part.user))

        // Fix 2 : si l'autre participant a supprimé sa copie de la conv,
        // récupérer ses infos depuis l'historique des messages
        const hasOther = participants.some((u) => u && u.id !== userId && !isAdminUser(u))
        if (!hasOther) {
          const otherMsg = await prisma.message.findFirst({
            where: { conversationId: c.id, NOT: { senderId: userId } },
            include: { sender: { include: { profile: true } } },
            orderBy: { createdAt: 'desc' },
          })
          if (otherMsg?.sender) {
            participants = [...participants, pickUserPublic(otherMsg.sender)]
          }
        }

        return {
          id: c.id,
          participants: participants.filter(Boolean),
          lastMessage: (() => {
            if (!lastMessage) return ''
            if (lastMessage.type === 'PROFILE_SHARE') {
              try {
                const d = JSON.parse(lastMessage.content)
                return `📋 Fiche partagée : ${d.name || 'Utilisateur'}`
              } catch { return '📋 Fiche partagée' }
            }
            if (lastMessage.type === 'BOOKING_REQUEST') return '📅 Demande de booking'
            if (lastMessage.type === 'CANCELLATION_REQUEST') return '❌ Demande d\'annulation'
            return lastMessage.content ||
              (lastMessage.attachmentType === 'IMAGE' ? '📷 Image' : '') ||
              (lastMessage.attachmentType === 'VIDEO' ? '🎬 Vidéo' : '') ||
              (lastMessage.attachmentType === 'DOCUMENT' ? '📄 Document' : '') ||
              ''
          })(),
          lastMessageMeta: lastMessage
            ? {
                id: lastMessage.id,
                senderId: lastMessage.senderId,
                seen: lastMessage.seen,
                createdAt: lastMessage.createdAt,
                attachmentType: lastMessage.attachmentType,
              }
            : null,
          updatedAt: c.updatedAt,
        }
      })
    )

    const filtered = conversations.filter(
      (c) => !c.participants.some((u) => isAdminUser(u))
    )

    filtered.sort(
      (a, b) =>
        new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
    )

    return res.json({ conversations: filtered })
  } catch (err) {
    console.error('❌ [GET /conversations]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   GET /api/messages/unread-count
========================================================= */
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    const participations = await prisma.conversationParticipant.findMany({
      where: { userId },
      select: { conversationId: true },
    })

    const conversationIds = participations.map((p) => p.conversationId)
    if (!conversationIds.length) return res.json({ count: 0 })

    const count = await prisma.message.count({
      where: {
        conversationId: { in: conversationIds },
        seen: false,
        NOT: { senderId: userId },
      },
    })

    return res.json({ count })
  } catch (err) {
    console.error('❌ [GET /unread-count]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   GET /api/messages/messages/:conversationId
========================================================= */
router.get('/messages/:conversationId', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    const conversationId = Number(req.params.conversationId)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    // Mettre à jour lastActiveAt
    prisma.user.update({ where: { id: userId }, data: { lastActiveAt: new Date() } }).catch(() => {})
    if (!conversationId) return res.status(400).json({ error: 'conversationId invalide' })

    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId },
      include: {
        conversation: {
          include: {
            participants: { include: { user: true } },
          },
        },
      },
    })

    if (!participation) return res.status(403).json({ error: 'Forbidden' })
    if (participation.conversation.participants.some((p) => isAdminUser(p.user))) {
      return res.status(404).json({ error: 'Conversation introuvable' })
    }

    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      include: {
        sender: { include: { profile: true } },
        bookingRequest: {
          include: {
            requester: { select: { id: true, userId: true } },
            target:    { select: { id: true, userId: true } },
          },
        },
      },
    })

    const payload = messages.map((m) => {
      const br = m.bookingRequest
      // Résoudre l'userId de celui qui a demandé l'annulation
      let cancellationRequesterUserId = null
      if (br?.cancellationRequestedBy) {
        if (br.cancellationRequestedBy === br.requesterId) cancellationRequesterUserId = br.requester?.userId ?? null
        else if (br.cancellationRequestedBy === br.targetId) cancellationRequesterUserId = br.target?.userId ?? null
      }
      return {
      id: String(m.id),
      content: m.content || '',
      type: m.type || 'TEXT',
      bookingRequestId: m.bookingRequestId || null,
      bookingRequest: br ? {
        id: br.id,
        status: br.status,
        startDate: br.startDate,
        fee: br.fee,
        message: br.message,
        requesterId: br.requesterId,
        targetId: br.targetId,
        paymentStatus: br.paymentStatus,
        cancellationRequestedBy: br.cancellationRequestedBy ?? null,
        cancellationNote: br.cancellationNote ?? null,
        cancellationRequesterUserId,
        requesterUserId: br.requester?.userId ?? null,
        targetUserId: br.target?.userId ?? null,
      } : null,
      attachmentUrl: m.attachmentUrl || null,
      attachmentType: m.attachmentType || null,
      attachmentName: m.attachmentName || null,
      attachmentMimeType: m.attachmentMimeType || null,
      createdAt: m.createdAt,
      seen: m.seen,
      seenAt: m.seenAt,
      sender: {
        id: m.senderId,
        name: getUserDisplayName(m.sender),
        image: m.sender?.profile?.avatar || null,
      },
    }})

    return res.json(payload)
  } catch (err) {
    console.error('❌ [GET /messages/:conversationId]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   POST /api/messages/start  — créer ou trouver une conversation
========================================================= */
router.post('/start', requireAuth, async (req, res) => {
  try {
    const senderId = Number(req.user?.id)
    const recipientId = Number(req.body?.recipientId)

    if (!senderId) return res.status(401).json({ error: 'Unauthorized' })
    if (!recipientId) return res.status(400).json({ error: 'recipientId requis' })
    if (senderId === recipientId)
      return res.status(400).json({ error: 'Impossible de se contacter soi-même' })

    const recipient = await prisma.user.findUnique({
      where: { id: recipientId },
      include: { profile: true },
    })
    if (!recipient) return res.status(404).json({ error: 'Destinataire introuvable' })
    if (isAdminUser(recipient)) return res.status(403).json({ error: 'Action non autorisée' })

    let conversation = await prisma.conversation.findFirst({
      where: {
        AND: [
          { participants: { some: { userId: senderId } } },
          { participants: { some: { userId: recipientId } } },
        ],
      },
      include: {
        participants: { include: { user: { include: { profile: true } } } },
      },
    })

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          participants: {
            create: [{ userId: senderId }, { userId: recipientId }],
          },
        },
        include: {
          participants: { include: { user: { include: { profile: true } } } },
        },
      })
    }

    return res.json({
      conversationId: conversation.id,
      conversation: {
        id: conversation.id,
        participants: conversation.participants.map((part) => pickUserPublic(part.user)),
        updatedAt: conversation.updatedAt,
        createdAt: conversation.createdAt,
      },
    })
  } catch (err) {
    console.error('❌ [POST /start]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   POST /api/messages/send  — texte seul (garde pour compatibilité)
========================================================= */
router.post('/send', requireAuth, validate(conversationCreateSchema), async (req, res) => {
  try {
    const senderId = Number(req.user?.id)
    if (!senderId) return res.status(401).json({ error: 'Unauthorized' })

    const { recipientId, content } = req.body
    if (Number(recipientId) === senderId)
      return res.status(400).json({ error: 'Impossible de s\'envoyer un message à soi-même' })

    const recipient = await prisma.user.findUnique({
      where: { id: Number(recipientId) },
      select: { id: true, role: true },
    })
    if (!recipient) return res.status(404).json({ error: 'Destinataire introuvable' })
    if (isAdminUser(recipient)) return res.status(403).json({ error: 'Action non autorisée' })

    let conversation = await prisma.conversation.findFirst({
      where: {
        AND: [
          { participants: { some: { userId: senderId } } },
          { participants: { some: { userId: Number(recipientId) } } },
        ],
      },
    })

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          participants: {
            create: [{ userId: senderId }, { userId: Number(recipientId) }],
          },
        },
      })
    }

    const message = await prisma.message.create({
      data: {
        content: String(content).trim(),
        senderId,
        conversationId: conversation.id,
      },
      include: { sender: { include: { profile: true } } },
    })

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    })

    return res.json({
      conversationId: conversation.id,
      message: {
        id: String(message.id),
        content: message.content || '',
        attachmentUrl: null,
        attachmentType: null,
        attachmentName: null,
        createdAt: message.createdAt,
        seen: message.seen,
        sender: {
          id: message.senderId,
          name: getUserDisplayName(message.sender),
          image: message.sender?.profile?.avatar || null,
        },
      },
    })
  } catch (err) {
    console.error('❌ [POST /send]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   POST /api/messages/send-file  — texte + fichier (Cloudinary)
========================================================= */
router.post('/send-file', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'FILE_TOO_LARGE', max: '25MB' })
    if (err.code === 'LIMIT_UNEXPECTED_FILE')
      return res.status(400).json({ error: 'FORMAT_NOT_ALLOWED' })
    return res.status(400).json({ error: 'UPLOAD_ERROR', code: err.code })
  }
  if (err) return res.status(500).json({ error: 'Erreur serveur upload' })

  try {
    const senderId = Number(req.user?.id)
    if (!senderId) return res.status(401).json({ error: 'Unauthorized' })

    const { content, conversationId } = req.body
    const file = req.file

    if (!conversationId || (!content?.trim() && !file))
      return res.status(400).json({ error: 'conversationId et (content ou fichier) requis' })

    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId: Number(conversationId), userId: senderId },
    })
    if (!participation) return res.status(403).json({ error: 'Accès interdit à cette conversation' })

    let attachmentUrl = null
    let attachmentType = null
    let attachmentName = null
    let attachmentMimeType = null

    if (file) {
      // Vérification magic bytes pour les images
      if (!isMsgImageValid(file.buffer, file.mimetype)) {
        return res.status(400).json({ error: 'FORMAT_NOT_ALLOWED' })
      }

      try {
        const result = await uploadBufferToBlob(
          file.buffer,
          file.mimetype,
          file.originalname
        )
        attachmentUrl = result.secure_url
        attachmentType = detectAttachmentType(file.mimetype)
        attachmentName = file.originalname || null
        attachmentMimeType = file.mimetype || null
      } catch (uploadErr) {
        console.error('❌ Cloudinary upload error:', uploadErr)
        return res.status(500).json({ error: 'Erreur lors de l\'upload du fichier' })
      }
    }

    const message = await prisma.message.create({
      data: {
        content: content?.trim() ? String(content).trim() : null,
        attachmentUrl,
        attachmentType,
        attachmentName,
        attachmentMimeType,
        senderId,
        conversationId: Number(conversationId),
      },
      include: { sender: { include: { profile: true } } },
    })

    await prisma.conversation.update({
      where: { id: Number(conversationId) },
      data: { updatedAt: new Date() },
    })

    // ── Notification NEW_MESSAGE pour chaque autre participant ──────────────
    const senderName = displayName(message.sender)
    const otherParticipants = await prisma.conversationParticipant.findMany({
      where: { conversationId: Number(conversationId), NOT: { userId: senderId } },
      select: { userId: true },
    })
    for (const p of otherParticipants) {
      await createNotif({
        userId:    p.userId,
        type:      'NEW_MESSAGE',
        content:   `${senderName} vous a envoyé un message.`,
        actorId:   senderId,
        messageId: message.id,
      })
    }

    return res.json({
      conversationId: Number(conversationId),
      message: {
        id: String(message.id),
        content: message.content || '',
        attachmentUrl: message.attachmentUrl || null,
        attachmentType: message.attachmentType || null,
        attachmentName: message.attachmentName || null,
        attachmentMimeType: message.attachmentMimeType || null,
        createdAt: message.createdAt,
        seen: message.seen,
        sender: {
          id: message.senderId,
          name: getUserDisplayName(message.sender),
          image: message.sender?.profile?.avatar || null,
        },
      },
    })
  } catch (err) {
    console.error('❌ [POST /send-file]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
  }) // fin du callback upload.single
}) // fin de router.post /send-file

/* =========================================================
   POST /api/messages/mark-seen/:conversationId
========================================================= */
router.post('/mark-seen/:conversationId', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    const conversationId = Number(req.params.conversationId)
    if (!userId || !conversationId)
      return res.status(400).json({ error: 'Paramètres invalides' })

    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId },
    })
    if (!participation) return res.status(403).json({ error: 'Accès interdit' })

    await prisma.message.updateMany({
      where: { conversationId, seen: false, NOT: { senderId: userId } },
      data: { seen: true, seenAt: new Date() },
    })

    return res.json({ ok: true })
  } catch (err) {
    console.error('❌ [POST /mark-seen]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   DELETE /api/messages/conversations/:conversationId
   ➜ Retire l'utilisateur de la conversation (soft delete).
     La conversation n'est supprimée en base que si plus
     aucun participant ne la possède.
========================================================= */
router.delete('/conversations/:conversationId', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    const conversationId = Number(req.params.conversationId)
    if (!userId || !conversationId)
      return res.status(400).json({ error: 'Paramètres invalides' })

    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId },
    })
    if (!participation) return res.status(403).json({ error: 'Accès interdit' })

    // Retirer seulement CE participant
    await prisma.conversationParticipant.deleteMany({ where: { conversationId, userId } })

    // Vérifier s'il reste d'autres participants
    const remaining = await prisma.conversationParticipant.count({ where: { conversationId } })

    if (remaining === 0) {
      // Plus personne : supprimer complètement la conversation
      await prisma.notification.deleteMany({ where: { message: { conversationId } } })
      await prisma.message.deleteMany({ where: { conversationId } })
      await prisma.conversation.delete({ where: { id: conversationId } })
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error('❌ [DELETE /conversations]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/messages/share-profile — Partager un profil dans une conversation
router.post('/share-profile', requireAuth, async (req, res) => {
  const { conversationId, profileUserId } = req.body
  const senderId = Number(req.user.id)
  if (!conversationId || !profileUserId) return res.status(400).json({ error: 'Paramètres manquants' })
  try {
    // Vérifier que l'expéditeur est participant
    const participant = await prisma.conversationParticipant.findFirst({
      where: { conversationId: Number(conversationId), userId: senderId },
    })
    if (!participant) return res.status(403).json({ error: 'Non autorisé' })

    // Récupérer les infos du profil partagé
    const targetUser = await prisma.user.findUnique({
      where: { id: Number(profileUserId) },
      include: { profile: { select: { avatar: true, profession: true, location: true } } },
    })
    if (!targetUser) return res.status(404).json({ error: 'Utilisateur introuvable' })

    const displayNameStr = targetUser.pseudo || [targetUser.firstName, targetUser.lastName].filter(Boolean).join(' ') || 'Utilisateur'
    const roleLinks = { ARTIST: 'artist', ORGANIZER: 'organizer', PROVIDER: 'provider' }
    const profileUrl = `/${roleLinks[targetUser.role] || 'artist'}/${targetUser.profile?.id || targetUser.id}`

    const sharedData = JSON.stringify({
      userId: targetUser.id,
      profileId: targetUser.profile?.id || null,
      name: displayNameStr,
      role: targetUser.role,
      avatar: targetUser.profile?.avatar || null,
      profession: targetUser.profile?.profession || null,
      location: targetUser.profile?.location || null,
      profileUrl,
    })

    const message = await prisma.message.create({
      data: {
        conversationId: Number(conversationId),
        senderId,
        content: sharedData,
        type: 'PROFILE_SHARE',
      },
      include: { sender: true },
    })

    await prisma.conversation.update({
      where: { id: Number(conversationId) },
      data: { updatedAt: new Date() },
    })

    res.json(message)
  } catch (err) {
    console.error('share-profile:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// GET /api/messages/status/:userId — statut en ligne d'un utilisateur
router.get('/status/:userId', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId)
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { lastActiveAt: true } })
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' })
    const lastSeen = u.lastActiveAt
    const isOnline = lastSeen && (Date.now() - new Date(lastSeen).getTime()) < 2 * 60 * 1000
    res.json({ online: !!isOnline, lastActiveAt: lastSeen?.toISOString() || null })
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
