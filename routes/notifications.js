const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');

/* =========================================================
   GET /api/notifications
   ➜ Lister les notifications d’un utilisateur
========================================================= */
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        actor: {
          select: {
            id:        true,
            pseudo:    true,
            firstName: true,
            lastName:  true,
            role:      true,
            profile: { select: { avatar: true } },
          },
        },
        message: {
          select: {
            id: true,
            conversationId: true,
          },
        },
      },
    });
    // ⚡️ Normalisation du format
    const formatted = notifications.map((n) => ({
      id: n.id,
      type: n.type,
      content: n.content || '', // ✅ le texte de la notif
      read: n.read,
      createdAt: n.createdAt,
      actor: n.actor
        ? {
            id:     n.actor.id,
            name:   n.actor.pseudo || [n.actor.firstName, n.actor.lastName].filter(Boolean).join(' ') || null,
            role:   n.actor.role || null,
            avatar: n.actor.profile?.avatar || null,
          }
        : null,
      conversationId: n.message?.conversationId || null,
      messageId:      n.message?.id || null,
      offerId:        n.offerId || null,
      publicationId:  n.publicationId || null,
      deviceToken:    n.deviceToken || null,
    }));
    console.log(`Notifications retournées pour user ${userId}: ${formatted.length}`); // ✅ Log pour débogage
    res.json({ notifications: formatted });
  } catch (err) {
    console.error('❌ [GET /notifications] Error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
   PATCH /api/notifications/mark-all-read
   ➜ Marquer toutes les notifications comme lues
   ⚠️  Doit être défini AVANT /:id pour éviter le conflit de route
========================================================= */
router.patch('/mark-all-read', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    await prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('❌ [PATCH /notifications/mark-all-read] Error:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   PATCH /api/notifications/:id
   ➜ Marquer une notification comme lue
========================================================= */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const notificationId = Number(req.params.id);
    if (!userId || !notificationId)
      return res.status(400).json({ error: 'Paramètres invalides' });
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

/* =========================================================
   GET /api/notifications/unread-count
   ➜ Nombre de notifications non lues
========================================================= */
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    const count = await prisma.notification.count({
      where: { userId, read: false },
    })
    res.json({ count })
  } catch (err) {
    console.error('❌ [GET /notifications/unread-count] Error:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router;