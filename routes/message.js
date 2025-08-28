const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticateToken = require('../middleware/authenticate');
const multer = require('multer');
const path = require('path');

/* ======================= Multer (upload disque) ======================= */
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'));
  },
});
const upload = multer({ storage });

/* Petite aide : inclure avatar de profil avec l’utilisateur */
const userWithProfileSelect = {
  id: true,
  name: true,
  email: true,
  image: true,
  profile: { select: { avatar: true } },
};

/* ======================= Conversations (liste) ======================= */
/** Récupérer toutes les conversations de l'utilisateur connecté */
router.get('/conversations', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const participations = await prisma.conversationParticipant.findMany({
      where: { userId },
      include: {
        conversation: {
          include: {
            participants: {
              include: {
                user: { select: userWithProfileSelect },
              },
            },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
      orderBy: { conversation: { updatedAt: 'desc' } },
    });

    const conversations = participations.map((p) => {
      const c = p.conversation;
      return {
        id: c.id,
        participants: c.participants.map((part) => part.user),
        lastMessage: c.messages[0]?.content || '',
        updatedAt: c.updatedAt,
      };
    });

    res.json(conversations);
  } catch (err) {
    console.error('Erreur lors de la récupération des conversations :', err);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

/* ======================= Messages d’une conversation ======================= */
/** Récupérer les messages d'une conversation (sécurisé) */
router.get('/messages/:conversationId', authenticateToken, async (req, res) => {
  const { conversationId } = req.params;
  const convId = parseInt(conversationId, 10);

  try {
    // Sécurité : vérifier que l’utilisateur est participant
    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId: convId, userId: req.user.id },
    });
    if (!participation) {
      return res.status(404).json({ error: 'Conversation introuvable ou non autorisée' });
    }

    const messages = await prisma.message.findMany({
      where: { conversationId: convId },
      orderBy: { createdAt: 'asc' },
      include: {
        sender: { select: userWithProfileSelect },
      },
    });

    // Remap pour coller à ton front (sender { id, name, image })
    const mapped = messages.map((m) => ({
      id: String(m.id),
      content: m.content,
      createdAt: m.createdAt,
      seen: m.seen ?? false,
      sender: {
        id: m.sender?.id,
        name: m.sender?.name,
        image: m.sender?.profile?.avatar || m.sender?.image || null,
      },
    }));

    res.json(mapped);
  } catch (err) {
    console.error('Erreur lors de la récupération des messages :', err);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

/* ======================= Marquer "VU" ======================= */
/** Marquer tous les messages reçus comme vus (principal) */
router.post('/mark-seen/:conversationId', authenticateToken, async (req, res) => {
  const convId = parseInt(req.params.conversationId, 10);
  try {
    // Vérifier participation
    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId: convId, userId: req.user.id },
    });
    if (!participation) {
      return res.status(404).json({ error: 'Conversation introuvable ou non autorisée' });
    }

    await prisma.message.updateMany({
      where: {
        conversationId: convId,
        senderId: { not: req.user.id },
        seen: false,
      },
      data: { seen: true },
    });

    res.status(204).send();
  } catch (err) {
    console.error('Erreur mark-seen :', err);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

/** Fallback ancien endpoint (compat front) */
router.post('/seen/:conversationId', authenticateToken, async (req, res) => {
  const convId = parseInt(req.params.conversationId, 10);
  try {
    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId: convId, userId: req.user.id },
    });
    if (!participation) {
      return res.status(404).json({ error: 'Conversation introuvable ou non autorisée' });
    }

    await prisma.message.updateMany({
      where: {
        conversationId: convId,
        senderId: { not: req.user.id },
        seen: false,
      },
      data: { seen: true },
    });

    res.status(204).send();
  } catch (err) {
    console.error('Erreur seen :', err);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

/* ======================= Envoyer message (anti-doublon) ======================= */
/** Envoyer un message (création auto de la conversation si besoin) */
router.post('/send', authenticateToken, async (req, res) => {
  const { recipientId, content } = req.body;
  const senderId = req.user.id;

  if (!recipientId || (!content || String(content).trim() === '')) {
    return res.status(400).json({ error: 'Destinataire et contenu requis' });
  }

  try {
    // ✅ Conversation existante = celle qui contient les DEUX participants
    const existingConversation = await prisma.conversation.findFirst({
      where: {
        participants: {
          some: { userId: senderId },
        },
        AND: {
          participants: {
            some: { userId: Number(recipientId) },
          },
        },
      },
      include: { participants: true },
    });

    const conversation = existingConversation
      ? existingConversation
      : await prisma.conversation.create({
          data: {
            participants: {
              create: [{ userId: senderId }, { userId: Number(recipientId) }],
            },
          },
        });

    const message = await prisma.message.create({
      data: {
        content: String(content),
        senderId,
        conversationId: conversation.id,
        seen: false,
      },
    });

    // Met à jour l’updatedAt de la conversation
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    res.json({
      id: message.id,
      conversationId: conversation.id,
      content: message.content,
      createdAt: message.createdAt,
    });
  } catch (err) {
    console.error("Erreur lors de l'envoi du message :", err);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

/* ======================= Envoyer message + fichier ======================= */
router.post('/send-file', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const { content, conversationId } = req.body;
    const file = req.file;

    if (!conversationId || (!content && !file)) {
      return res.status(400).json({ error: 'Contenu ou fichier requis' });
    }

    const convId = parseInt(conversationId, 10);

    // Vérifier participation
    const participation = await prisma.conversationParticipant.findFirst({
      where: { conversationId: convId, userId: req.user.id },
    });
    if (!participation) {
      return res.status(404).json({ error: 'Conversation introuvable ou non autorisée' });
    }

    const cleanFileUrl = file
      ? `https://lsbookers-backend-production.up.railway.app/uploads/${file.filename}`
      : null;

    let finalContent = '';
    if (file && content) finalContent = `${content}\n${cleanFileUrl}`;
    else if (file) finalContent = `Lien : ${cleanFileUrl}`;
    else finalContent = content;

    const newMessage = await prisma.message.create({
      data: {
        senderId: req.user.id,
        conversationId: convId,
        content: finalContent,
        seen: false,
      },
    });

    // Touch updatedAt
    await prisma.conversation.update({
      where: { id: convId },
      data: { updatedAt: new Date() },
    });

    return res.json({
      id: newMessage.id,
      content: newMessage.content,
      senderId: newMessage.senderId,
      conversationId: newMessage.conversationId,
      createdAt: newMessage.createdAt,
      fileUrl: cleanFileUrl,
    });
  } catch (err) {
    console.error('Erreur send-file :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ======================= Supprimer conversation ======================= */
/** Supprime une conversation (hard delete) si l’utilisateur est participant */
router.delete('/conversations/:id', authenticateToken, async (req, res) => {
  const convId = parseInt(req.params.id, 10);

  try {
    // Vérifier que la conversation existe et que l’utilisateur y participe
    const conv = await prisma.conversation.findUnique({
      where: { id: convId },
      include: {
        participants: true,
      },
    });

    if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });

    const isParticipant = conv.participants.some((p) => p.userId === req.user.id);
    if (!isParticipant) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    // Supprimer messages + participations + conversation
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { conversationId: convId } }),
      prisma.conversationParticipant.deleteMany({ where: { conversationId: convId } }),
      prisma.conversation.delete({ where: { id: convId } }),
    ]);

    return res.status(204).send();
  } catch (err) {
    console.error('Erreur suppression conversation :', err);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

module.exports = router;