const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticateToken = require('../middleware/authenticate');

// Lister les notifications d'un utilisateur
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ notifications });
  } catch (err) {
    console.error('❌ [GET /notifications] Error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Marquer une notification comme lue
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const notificationId = Number(req.params.id);
    if (!userId || !notificationId) return res.status(400).json({ error: 'Paramètres invalides' });

    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification || notification.userId !== userId) {
      return res.status(404).json({ error: 'Notification introuvable' });
    }

    await prisma.notification.update({
      where: { id: notificationId },
      data: { read: true },
    });

    res.json({ message: 'Notification marquée comme lue ✅' });
  } catch (err) {
    console.error('❌ [PATCH /notifications/:id] Error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;