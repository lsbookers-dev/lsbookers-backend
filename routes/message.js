const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const authenticateToken = require('../middleware/authenticate')
const multer = require('multer')
const path = require('path')

/* ------------ Multer (upload local temporaire) ------------ */
const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (_req, file, cb) {
    const safeName = file.originalname.replace(/\s/g, '_')
    cb(null, `${Date.now()}-${safeName}`)
  },
})

const upload = multer({ storage })

/* ------------ Helpers ------------ */
function pickUserPublic(u) {
  if (!u) return null
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    image: u.image || null,
    profile: u.profile ? { avatar: u.profile.avatar || null } : null,
  }
}

const isAdminUser = (u) => !!u && String(u.role).toUpperCase() === 'ADMIN'

async function conversationHasAdmin(conversationId) {
  const conv = await prisma.conversation.findUnique({
    where: { id: Number(conversationId) },
    include: {
      participants: {
        include: {
          user: true,
        },
      },
    },
  })

  if (!conv) return false
  return conv.participants.some((p) => isAdminUser(p.user))
}

function detectAttachmentType(file) {
  if (!file?.mimetype) return null
  if (file.mimetype.startsWith('image/')) return 'IMAGE'
  if (file.mimetype.startsWith('video/')) return 'VIDEO'
  return 'DOCUMENT'
}

function buildFileUrl(file) {
  if (!file) return null
  return `https://lsbookers-backend-production.up.railway.app/uploads/${file.filename}`
}

/* =========================================================
   GET /api/messages/conversations
========================================================= */
router.get('/conversations', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    const participations = await prisma.conversationParticipant.findMany({
      where: { userId },
      include: {
        conversation: {
          include: {
            participants: {
              include: {
                user: {
                  include: { profile: true },
                },
              },
            },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    })

    const conversations = participations
      .map((p) => {
        const c = p.conversation
        const lastMessage = c.messages[0] || null

        return {
          id: c.id,
          participants: c.participants.map((part) => pickUserPublic(part.user)),
          lastMessage:
            lastMessage?.content ||
            lastMessage?.attachmentName ||
            (lastMessage?.attachmentUrl ? 'Pièce jointe' : ''),
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
      .filter((c) => c.participants.every((u) => !isAdminUser(u)))

    conversations.sort(
      (a, b) =>
        new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
    )

    return res.json({ conversations })
  } catch (err) {
    console.error('❌ [GET /conversations] Error:', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   GET /api/messages/unread-count
========================================================= */
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    const participations = await prisma.conversationParticipant.findMany({
      where: { userId },
      select: { conversationId: true },
    })

    const conversationIds = participations.map((p) => p.conversationId)

    if (!conversationIds.length) {
      return res.json({ count: 0 })
    }

    const unreadCount = await prisma.message.count({
      where: {
        conversationId: { in: conversationIds },
        seen: false,
        NOT: {
          senderId: userId,
        },
      },
    })

    return res.json({ count: unreadCount })
  } catch (err) {
    console.error('❌ [GET /unread-count] Error:', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   GET /api/messages/messages/:conversationId
========================================================= */
router.get('/messages/:conversationId', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    const conversationId = Number(req.params.conversationId)
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId invalide' })
    }

    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId },
      include: {
        conversation: {
          include: {
            participants: {
              include: {
                user: true,
              },
            },
          },
        },
      },
    })

    if (!participation) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    if (participation.conversation.participants.some((p) => isAdminUser(p.user))) {
      return res.status(404).json({ error: 'Conversation introuvable' })
    }

    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      include: {
        sender: {
          include: {
            profile: true,
          },
        },
      },
    })

    const payload = messages.map((m) => ({
      id: String(m.id),
      content: m.content || '',
      attachmentUrl: m.attachmentUrl || null,
      attachmentType: m.attachmentType || null,
      attachmentName: m.attachmentName || null,
      attachmentMimeType: m.attachmentMimeType || null,
      createdAt: m.createdAt,
      seen: m.seen,
      seenAt: m.seenAt,
      sender: {
        id: m.senderId,
        name: m.sender?.name || 'Utilisateur',
        image: m.sender?.profile?.avatar || m.sender?.image || null,
      },
    }))

    return res.json(payload)
  } catch (err) {
    console.error('❌ [GET /messages/:conversationId] Error:', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   POST /api/messages/start
   ➜ créer ou retrouver une conversation SANS envoyer de message auto
========================================================= */
router.post('/start', authenticateToken, async (req, res) => {
  try {
    const senderId = Number(req.user?.id)
    const recipientId = Number(req.body?.recipientId)

    if (!senderId) return res.status(401).json({ error: 'Unauthorized' })
    if (!recipientId) return res.status(400).json({ error: 'recipientId requis' })
    if (senderId === recipientId) {
      return res.status(400).json({ error: 'Impossible de créer une conversation avec soi-même' })
    }

    const recipient = await prisma.user.findUnique({
      where: { id: recipientId },
      include: { profile: true },
    })

    if (!recipient) {
      return res.status(404).json({ error: 'Destinataire introuvable' })
    }

    if (isAdminUser(recipient)) {
      return res.status(403).json({ error: 'Action non autorisée' })
    }

    let conversation = await prisma.conversation.findFirst({
      where: {
        AND: [
          { participants: { some: { userId: senderId } } },
          { participants: { some: { userId: recipientId } } },
        ],
      },
      include: {
        participants: {
          include: {
            user: { include: { profile: true } },
          },
        },
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
          participants: {
            include: {
              user: { include: { profile: true } },
            },
          },
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
    console.error('❌ [POST /start] Error:', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   POST /api/messages/send
   ➜ texte seul
========================================================= */
router.post('/send', authenticateToken, async (req, res) => {
  try {
    const senderId = Number(req.user?.id)
    if (!senderId) return res.status(401).json({ error: 'Unauthorized' })

    const { recipientId, content } = req.body

    if (!recipientId || !content || !String(content).trim()) {
      return res.status(400).json({ error: 'recipientId et content requis' })
    }

    if (Number(recipientId) === senderId) {
      return res.status(400).json({ error: 'Impossible de s’envoyer un message à soi-même' })
    }

    const recipient = await prisma.user.findUnique({
      where: { id: Number(recipientId) },
      select: { id: true, role: true },
    })

    if (!recipient) {
      return res.status(404).json({ error: 'Destinataire introuvable' })
    }

    if (isAdminUser(recipient)) {
      return res.status(403).json({ error: 'Action non autorisée' })
    }

    let conversation = await prisma.conversation.findFirst({
      where: {
        AND: [
          { participants: { some: { userId: senderId } } },
          { participants: { some: { userId: Number(recipientId) } } },
        ],
      },
      include: {
        participants: {
          include: {
            user: true,
          },
        },
      },
    })

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          participants: {
            create: [{ userId: senderId }, { userId: Number(recipientId) }],
          },
        },
        include: {
          participants: {
            include: {
              user: true,
            },
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
      include: {
        sender: {
          include: {
            profile: true,
          },
        },
      },
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
        attachmentUrl: message.attachmentUrl || null,
        attachmentType: message.attachmentType || null,
        attachmentName: message.attachmentName || null,
        attachmentMimeType: message.attachmentMimeType || null,
        createdAt: message.createdAt,
        seen: message.seen,
        seenAt: message.seenAt,
        sender: {
          id: message.senderId,
          name: message.sender?.name || 'Utilisateur',
          image: message.sender?.profile?.avatar || message.sender?.image || null,
        },
      },
    })
  } catch (err) {
    console.error('❌ [POST /send] Error:', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   POST /api/messages/send-file
========================================================= */
router.post('/send-file', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const senderId = Number(req.user?.id)
    if (!senderId) return res.status(401).json({ error: 'Unauthorized' })

    const { content, conversationId } = req.body
    const file = req.file

    if (!conversationId || (!content?.trim() && !file)) {
      return res.status(400).json({ error: 'conversationId et (content ou file) requis' })
    }

    if (await conversationHasAdmin(Number(conversationId))) {
      return res.status(403).json({ error: 'Action non autorisée' })
    }

    const participation = await prisma.conversationParticipant.findFirst({
      where: {
        conversationId: Number(conversationId),
        userId: senderId,
      },
    })

    if (!participation) {
      return res.status(403).json({ error: 'Accès interdit à cette conversation' })
    }

    const attachmentUrl = buildFileUrl(file)
    const attachmentType = detectAttachmentType(file)
    const attachmentName = file?.originalname || null
    const attachmentMimeType = file?.mimetype || null

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
      include: {
        sender: {
          include: {
            profile: true,
          },
        },
      },
    })

    await prisma.conversation.update({
      where: { id: Number(conversationId) },
      data: { updatedAt: new Date() },
    })

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
        seenAt: message.seenAt,
        sender: {
          id: message.senderId,
          name: message.sender?.name || 'Utilisateur',
          image: message.sender?.profile?.avatar || message.sender?.image || null,
        },
      },
    })
  } catch (err) {
    console.error('❌ [POST /send-file] Error:', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   POST /api/messages/mark-seen/:conversationId
========================================================= */
router.post('/mark-seen/:conversationId', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    const conversationId = Number(req.params.conversationId)

    if (!userId || !conversationId) {
      return res.status(400).json({ error: 'Paramètres invalides' })
    }

    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId },
    })

    if (!participation) {
      return res.status(403).json({ error: 'Accès interdit' })
    }

    await prisma.message.updateMany({
      where: {
        conversationId,
        seen: false,
        NOT: { senderId: userId },
      },
      data: {
        seen: true,
        seenAt: new Date(),
      },
    })

    return res.json({ message: 'Messages marqués comme lus' })
  } catch (err) {
    console.error('❌ [POST /mark-seen] Error:', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   DELETE /api/messages/conversations/:conversationId
========================================================= */
router.delete('/conversations/:conversationId', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    const conversationId = Number(req.params.conversationId)

    if (!userId || !conversationId) {
      return res.status(400).json({ error: 'Paramètres invalides' })
    }

    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId },
    })

    if (!participation) {
      return res.status(403).json({ error: 'Accès interdit' })
    }

    await prisma.notification.deleteMany({
      where: { message: { conversationId } },
    })

    await prisma.message.deleteMany({
      where: { conversationId },
    })

    await prisma.conversationParticipant.deleteMany({
      where: { conversationId },
    })

    await prisma.conversation.delete({
      where: { id: conversationId },
    })

    return res.json({ message: 'Conversation supprimée' })
  } catch (err) {
    console.error('❌ [DELETE /conversations/:conversationId] Error:', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router