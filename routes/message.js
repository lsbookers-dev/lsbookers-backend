const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticateToken = require('../middleware/authenticate');
const multer = require('multer');
const path = require('path');

// Configuration de multer pour stocker les fichiers dans /uploads/
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

// 🔹 Récupérer toutes les conversations de l'utilisateur connecté
router.get('/conversations', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const participations = await prisma.conversationParticipant.findMany({
      where: { userId },
      include: {
        conversation: {
          include: {
            participants: {
              include: { user: true },
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

// 🔹 Récupérer les messages d'une conversation
router.get('/messages/:conversationId', authenticateToken, async (req, res) => {
  const { conversationId } = req.params;

  try {
    const messages = await prisma.message.findMany({
      where: {
        conversationId: parseInt(conversationId),
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    res.json(messages);
  } catch (err) {
    console.error('Erreur lors de la récupération des messages :', err);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

// 🔹 Envoyer un message (création auto de la conversation si besoin)
router.post('/send', authenticateToken, async (req, res) => {
  const { recipientId, content } = req.body;
  const senderId = req.user.id;

  try {
    const existingConversation = await prisma.conversation.findFirst({
      where: {
        participants: {
          some: { userId: senderId },
        },
      },
      include: {
        participants: true,
      },
    });

    let conversation;

    if (
      existingConversation &&
      existingConversation.participants.some((p) => p.userId === recipientId)
    ) {
      conversation = existingConversation;
    } else {
      conversation = await prisma.conversation.create({
        data: {
          participants: {
            create: [
              { userId: senderId },
              { userId: recipientId },
            ],
          },
        },
      });
    }

    const message = await prisma.message.create({
      data: {
        content,
        senderId,
        conversationId: conversation.id,
      },
    });

    res.json(message);
  } catch (err) {
    console.error("Erreur lors de l'envoi du message :", err);
    res.status(500).json({ error: 'Erreur serveur ❌' });
  }
});

// 🔹 Envoyer un message avec un fichier (texte facultatif)
router.post('/send-file', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const { content, conversationId } = req.body;
    const file = req.file;

    if (!conversationId || (!content && !file)) {
      return res.status(400).json({ error: 'Contenu ou fichier requis' });
    }

    const cleanFileUrl = file ? `http://localhost:5001/uploads/${file.filename}` : null;

    const messageData = {
      senderId: req.user.id,
      conversationId: parseInt(conversationId),
      content: '',
    };

    if (file && content) {
      messageData.content = `${content}\n${cleanFileUrl}`;
    } else if (file) {
      messageData.content = `Fichier envoyé :\n${cleanFileUrl}`;
    } else {
      messageData.content = content;
    }

    const newMessage = await prisma.message.create({
      data: messageData,
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
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;