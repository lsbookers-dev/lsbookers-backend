// routes/message.js
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
  // Ajuste ces champs selon ton schéma User
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    image: u.image || null,
    profile: u.profile ? { avatar: u.profile.avatar || null } : null,
  };
}

/* =========================================================
   GET /api/messages/conversations
   ➜ conversations de l’utilisateur connecté
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
                user: {
                  include: {
                    profile: true, // doit contenir avatar
                  },
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
    });

    const conversations = participations.map((p) => {
      const c = p.conversation;
      return {
        id: c.id,
        participants: c.participants.map((part) => pickUserPublic(part.user)),
        lastMessage: c.messages[0]?.content || '',
        updatedAt: c.updatedAt,
      };
    });

    // Optionnel : tri par updatedAt DESC (au cas où)
    conversations.sort(
      (a, b) =>
        new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
    );

    res.json({ conversations });
  } catch (err) {
    console.error('❌ [GET /conversations] Error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
   GET /api/messages/messages/:conversationId
   ➜ messages d’une conversation
========================================================= */
router.get('/messages/:conversationId', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const conversationId = Number(req.params.conversationId);
    if (!conversationId) return res.status(400).json({ error: 'conversationId invalide' });

    // Vérifie que l’utilisateur est bien participant
    const isParticipant = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId },
    });
    if (!isParticipant) return res.status(403).json({ error: 'Forbidden' });

    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      include: {
        sender: {
          include: {
            profile: true, // pour récupérer avatar si tu veux l’exposer ici
          },
        },
      },
    });

    // Normalise la forme attendue par le front (sender.image)
    const payload = messages.map((m) => ({
      id: String(m.id),
      content: m.content,
      createdAt: m.createdAt,
      seen: m.seen,
      sender: {
        id: m.senderId,
        name: m.sender?.name || 'Utilisateur',
        image: (m.sender?.profile?.avatar || m.sender?.image || null),
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
   ➜ créer/rouvrir conversation + envoyer message texte
========================================================= */
router.post('/send', authenticateToken, async (req, res) => {
  try {
    const senderId = Number(req.user?.id);
    if (!senderId) return res.status(401).json({ error: 'Unauthorized' });

    const { recipientId, content } = req.body;
    if (!recipientId || (!content || !String(content).trim())) {
      return res.status(400).json({ error: 'recipientId et content requis' });
    }

    // Trouve une conv entre ces 2 utilisateurs (peu importe l’ordre)
    let conversation = await prisma.conversation.findFirst({
      where: {
        AND: [
          { participants: { some: { userId: senderId } } },
          { participants: { some: { userId: Number(recipientId) } } },
        ],
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          participants: {
            create: [{ userId: senderId }, { userId: Number(recipientId) }],
          },
        },
      });
    }

    const message = await prisma.message.create({
      data: {
        content: String(content),
        senderId,
        conversationId: conversation.id,
      },
    });

    // Met à jour updatedAt pour l’ordre des conversations
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
   ➜ envoyer message avec fichier (content facultatif)
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

    // URL publique (adapter selon ton hébergeur)
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

/* =========================================================
   POST /api/messages/mark-seen/:conversationId
   ➜ marquer comme vus tous les messages reçus
========================================================= */
router.post('/mark-seen/:conversationId', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const conversationId = Number(req.params.conversationId);
    if (!conversationId) return res.status(400).json({ error: 'conversationId invalide' });

    // L’utilisateur doit être participant
    const isParticipant = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId },
    });
    if (!isParticipant) return res.status(403).json({ error: 'Forbidden' });

    const result = await prisma.message.updateMany({
      where: {
        conversationId,
        seen: false,
        // on ne marque pas “vu” ses propres messages
        NOT: { senderId: userId },
      },
      data: { seen: true },
    });

    res.json({ updated: result.count });
  } catch (err) {
    console.error('❌ [POST /mark-seen] Error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
   DELETE /api/messages/conversations/:id
   ➜ supprime la conversation (et messages)
========================================================= */
router.delete('/conversations/:id', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const conversationId = Number(req.params.id);
    if (!conversationId) return res.status(400).json({ error: 'conversationId invalide' });

    const isParticipant = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId },
    });
    if (!isParticipant) return res.status(403).json({ error: 'Forbidden' });

    // Supprime messages + participations + conversation
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { conversationId } }),
      prisma.conversationParticipant.deleteMany({ where: { conversationId } }),
      prisma.conversation.delete({ where: { id: conversationId } }),
    ]);

    res.status(204).end();
  } catch (err) {
    console.error('❌ [DELETE /conversations/:id] Error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;