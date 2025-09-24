const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticateToken = require('../middleware/authenticate');
const multer = require('multer');
const path = require('path');

/* ------------ Multer (upload local si besoin) ------------ */
const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'));
  },
});
const upload = multer({ storage });

/* ------------ Helpers ------------ */
function pickUserPublic(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    image: u.image || null,
    profile: u.profile ? { avatar: u.profile.avatar || null } : null,
  };
}

const isAdminUser = (u) => !!u && String(u.role).toUpperCase() === 'ADMIN';

/* Petite utilitaire : vérifie si une conversation implique un ADMIN */
async function conversationHasAdmin(conversationId) {
  const conv = await prisma.conversation.findUnique({
    where: { id: Number(conversationId) },
    include: {
      participants: {
        include: { user: true },
      },
    },
  });
  if (!conv) return false;
  return conv.participants.some((p) => isAdminUser(p.user));
}

/* =========================================================
   GET /api/messages/conversations
========================================================= */
router.get('/conversations', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const participations = await prisma.conversationParticipant.findMany({
      where: { userId },
      include: {
        conversation: {
          include: {
            participants: {
              include: {
                user: { include: { profile: true } },
              },
            },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });
    const conversations = participations
      .map((p) => {
        const c = p.conversation;
        return {
          id: c.id,
          participants: c.participants.map((part) => pickUserPublic(part.user)),
          lastMessage: c.messages[0]?.content || '',
          updatedAt: c.updatedAt,
        };
      })
      .filter((c) => c.participants.every((u) => !isAdminUser(u)));
    conversations.sort(
      (a, b) =>
        new Date(b.updatedAt || 0).getTime() -
        new Date(a.updatedAt || 0).getTime()
    );
    res.json({ conversations });
  } catch (err) {
    console.error('❌ [GET /conversations] Error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
   GET /api/messages/unread-count
========================================================= */
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const convs = await prisma.conversation.findMany({
      where: { participants: { some: { userId } } },
      select: {
        id: true,
        messages: {
          select: { id: true, senderId: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    const unreadCount = convs.reduce((acc, c) => {
      const last = c.messages[0];
      if (!last) return acc;
      return last.senderId !== userId ? acc + 1 : acc;
    }, 0);

    res.json({ count: unreadCount });
  } catch (err) {
    console.error('❌ [GET /unread-count] Error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
   GET /api/messages/messages/:conversationId
========================================================= */
router.get('/messages/:conversationId', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const conversationId = Number(req.params.conversationId);
    if (!conversationId) return res.status(400).json({ error: 'conversationId invalide' });

    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId },
      include: {
        conversation: {
          include: { participants: { include: { user: true } } },
        },
      },
    });
    if (!participation) return res.status(403).json({ error: 'Forbidden' });

    if (participation.conversation.participants.some((p) => isAdminUser(p.user))) {
      return res.status(404).json({ error: 'Conversation introuvable' });
    }

    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      include: { sender: { include: { profile: true } } },
    });

    const payload = messages.map((m) => ({
      id: String(m.id),
      content: m.content,
      createdAt: m.createdAt,
      seen: m.seen,
      sender: {
        id: m.senderId,
        name: m.sender?.name || 'Utilisateur',
        image: m.sender?.profile?.avatar || m.sender?.image || null,
      },
    }));
    res.json(payload);
  } catch (err) {
    console.error('❌ [GET /messages/:conversationId] Error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
   POST /api/messages/send
========================================================= */
router.post('/send', authenticateToken, async (req, res) => {
  try {
    const senderId = Number(req.user?.id);
    if (!senderId) return res.status(401).json({ error: 'Unauthorized' });
    const { recipientId, content } = req.body;
    if (!recipientId || (!content || !String(content).trim())) {
      return res.status(400).json({ error: 'recipientId et content requis' });
    }

    const recipient = await prisma.user.findUnique({
      where: { id: Number(recipientId) },
      select: { id: true, role: true, name: true },
    });
    if (!recipient) return res.status(404).json({ error: 'Destinataire introuvable' });
    if (isAdminUser(recipient)) {
      return res.status(403).json({ error: 'Action non autorisée' });
    }

    let conversation = await prisma.conversation.findFirst({
      where: {
        AND: [
          { participants: { some: { userId: senderId } } },
          { participants: { some: { userId: Number(recipientId) } } },
        ],
      },
      include: { participants: { include: { user: true } } },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          participants: {
            create: [{ userId: senderId }, { userId: Number(recipientId) }],
          },
        },
        include: { participants: { include: { user: true } } },
      });
    }

    const message = await prisma.message.create({
      data: {
        content: String(content),
        senderId,
        conversationId: conversation.id,
      },
    });

    await prisma.notification.create({
      data: {
        userId: Number(recipientId),
        type: 'NEW_MESSAGE',
        message: `Nouveau message de ${req.user.name || 'Utilisateur'}`,
        read: false,
        actorId: senderId,
        messageId: message.id,
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    res.json({
      conversationId: conversation.id,
      message: {
        id: message.id,
        content: message.content,
        createdAt: message.createdAt,
        senderId: message.senderId,
      },
    });
  } catch (err) {
    console.error('❌ [POST /send] Error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
   POST /api/messages/send-file
========================================================= */
router.post('/send-file', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const senderId = Number(req.user?.id);
    if (!senderId) return res.status(401).json({ error: 'Unauthorized' });
    const { content, conversationId } = req.body;
    const file = req.file;
    if (!conversationId || (!content && !file)) {
      return res.status(400).json({ error: 'conversationId et (content ou file) requis' });
    }

    if (await conversationHasAdmin(Number(conversationId))) {
      return res.status(403).json({ error: 'Action non autorisée' });
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: Number(conversationId) },
      include: { participants: { include: { user: true } } },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation introuvable' });

    const fileUrl = file
      ? `https://lsbookers-backend-production.up.railway.app/uploads/${file.filename}`
      : null;

    let finalContent = '';
    if (file && content) finalContent = `${content}\n${fileUrl}`;
    else if (file) finalContent = `Lien : ${fileUrl}`;
    else finalContent = String(content);

    const message = await prisma.message.create({
      data: {
        senderId,
        conversationId: Number(conversationId),
        content: finalContent,
      },
    });

    const recipients = conversation.participants
      .filter((p) => p.userId !== senderId)
      .map((p) => p.userId);

    for (const recipientId of recipients) {
      await prisma.notification.create({
        data: {
          userId: recipientId,
          type: 'NEW_MESSAGE',
          message: `Nouveau message de ${req.user.name || 'Utilisateur'}`,
          read: false,
          actorId: senderId,
          messageId: message.id,
        },
      });
    }

    await prisma.conversation.update({
      where: { id: Number(conversationId) },
      data: { updatedAt: new Date() },
    });

    return res.json({
      conversationId: Number(conversationId),
      message: {
        id: message.id,
        content: message.content,
        createdAt: message.createdAt,
        senderId: message.senderId,
      },
      fileUrl,
    });
  } catch (err) {
    console.error('❌ [POST /send-file] Error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;