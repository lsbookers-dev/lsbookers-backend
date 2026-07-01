const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAuth } = require('../middleware/auth');

/* ══════════════════════════════════════════════
   ÉVÉNEMENTS
══════════════════════════════════════════════ */

// GET /api/events/profile/:profileId — événements publics d'un profil
router.get('/profile/:profileId', async (req, res) => {
  const { profileId } = req.params;
  const { month, year } = req.query;
  try {
    const where = { profileId: parseInt(profileId), isPrivate: false, status: { not: 'DRAFT' } };
    if (month && year) {
      const start = new Date(parseInt(year), parseInt(month) - 1, 1);
      const end   = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59);
      where.start = { gte: start, lte: end };
    }
    const events = await prisma.event.findMany({
      where, orderBy: { start: 'asc' },
      select: { id: true, title: true, start: true, end: true, allDay: true, lieu: true, category: true, coverImage: true, status: true },
    });
    res.json({ events });
  } catch (err) {
    console.error('GET events/profile:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/events/my — mes événements (publics + privés)
router.get('/my', requireAuth, async (req, res) => {
  const { month, year } = req.query;
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    const where = { profileId: profile.id };
    if (month && year) {
      const start = new Date(parseInt(year), parseInt(month) - 1, 1);
      const end   = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59);
      where.start = { gte: start, lte: end };
    }
    const events = await prisma.event.findMany({ where, orderBy: { start: 'asc' }, include: { staff: true, documents: true } });
    res.json({ events });
  } catch (err) {
    console.error('GET events/my:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/events — créer un événement
router.post('/', requireAuth, async (req, res) => {
  const { title, description, start, end, allDay, lieu, category, isPrivate, budget, maxCapacity, status } = req.body;
  if (!title || !start) return res.status(400).json({ error: 'Titre et date de début requis' });
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    const event = await prisma.event.create({
      data: {
        title, description: description || null,
        start: new Date(start), end: end ? new Date(end) : null,
        allDay: allDay || false, lieu: lieu || null, category: category || null,
        isPrivate: isPrivate ?? false,
        budget: budget ? parseFloat(budget) : null,
        maxCapacity: maxCapacity ? parseInt(maxCapacity) : null,
        status: status || 'DRAFT', profileId: profile.id,
      },
    });
    res.status(201).json({ event });
  } catch (err) {
    console.error('POST events:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ══════════════════════════════════════════════
   DISPONIBILITÉS  (avant /:id pour éviter le conflit de route)
══════════════════════════════════════════════ */

// GET /api/events/availability/:profileId — dispos publiques
router.get('/availability/:profileId', async (req, res) => {
  const { profileId } = req.params;
  const { month, year } = req.query;
  try {
    const where = { profileId: parseInt(profileId) };
    if (month && year) {
      const start = new Date(parseInt(year), parseInt(month) - 1, 1);
      const end   = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59);
      where.date  = { gte: start, lte: end };
    }
    const availability = await prisma.availability.findMany({ where, orderBy: { date: 'asc' } });
    res.json({ availability });
  } catch (err) {
    console.error('GET availability:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/events/availability — définir dispo d'un jour
router.put('/availability', requireAuth, async (req, res) => {
  const { date, status, note } = req.body;
  if (!date || !status) return res.status(400).json({ error: 'Date et statut requis' });
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    const availability = await prisma.availability.upsert({
      where:  { profileId_date: { profileId: profile.id, date: new Date(date) } },
      update: { status, note: note || null },
      create: { profileId: profile.id, date: new Date(date), status, note: note || null },
    });
    res.json({ availability });
  } catch (err) {
    console.error('PUT availability:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/events/booking-request — envoyer une demande de booking
router.post('/booking-request', requireAuth, async (req, res) => {
  const { targetProfileId, date, message, fee } = req.body;
  if (!targetProfileId || !date) return res.status(400).json({ error: 'Profil cible et date requis' });
  try {
    const requesterProfile = await prisma.profile.findUnique({
      where: { userId: req.user.id },
      select: { id: true, userId: true, user: { select: { pseudo: true, firstName: true, lastName: true } } },
    });
    if (!requesterProfile) return res.status(404).json({ error: 'Profil introuvable' });
    if (requesterProfile.id === parseInt(targetProfileId)) return res.status(400).json({ error: 'Impossible de vous envoyer une demande à vous-même' });

    const targetProfile = await prisma.profile.findUnique({
      where: { id: parseInt(targetProfileId) },
      select: { id: true, userId: true },
    });
    if (!targetProfile) return res.status(404).json({ error: 'Profil cible introuvable' });

    // 1. Créer la BookingRequest
    const bookingRequest = await prisma.bookingRequest.create({
      data: {
        requesterId: requesterProfile.id,
        targetId:    targetProfile.id,
        startDate:   new Date(date),
        message:     message?.trim() || null,
        fee:         fee ? parseFloat(fee) : null,
        status:      'PENDING',
      },
    });

    // 2. Trouver ou créer une conversation entre les deux userId
    let conversation = await prisma.conversation.findFirst({
      where: {
        AND: [
          { participants: { some: { userId: req.user.id } } },
          { participants: { some: { userId: targetProfile.userId } } },
        ],
      },
    });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          participants: {
            create: [{ userId: req.user.id }, { userId: targetProfile.userId }],
          },
        },
      });
    }

    // 3. Envoyer un message de type BOOKING_REQUEST dans la conversation
    const dateLabel = new Date(date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const msgContent = `📅 Demande de booking pour le ${dateLabel}${fee ? ` · Cachet proposé : ${parseFloat(fee).toLocaleString('fr-FR')} €` : ''}${message ? `\n"${message.trim()}"` : ''}`;

    await prisma.message.create({
      data: {
        content:         msgContent,
        senderId:        req.user.id,
        conversationId:  conversation.id,
        type:            'BOOKING_REQUEST',
        bookingRequestId: bookingRequest.id,
      },
    });

    await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });

    // 4. Notification pour la cible
    const senderName = requesterProfile.user?.pseudo ||
      [requesterProfile.user?.firstName, requesterProfile.user?.lastName].filter(Boolean).join(' ') || 'Utilisateur';
    await prisma.notification.create({
      data: {
        userId:  targetProfile.userId,
        type:    'BOOKING_REQUEST',
        content: `Nouvelle demande de booking du ${dateLabel} de ${senderName}.`,
        actorId: req.user.id,
      },
    }).catch(() => {}); // non-bloquant

    res.status(201).json({ request: bookingRequest, conversationId: conversation.id });
  } catch (err) {
    console.error('POST booking-request:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/events/booking-requests — mes demandes reçues + envoyées (avec conversationId)
router.get('/booking-requests', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    const [received, sent] = await Promise.all([
      prisma.bookingRequest.findMany({
        where: { targetId: profile.id },
        orderBy: { createdAt: 'desc' },
        include: { requester: { select: { id: true, avatar: true, user: { select: { pseudo: true, firstName: true, lastName: true } } } } },
      }),
      prisma.bookingRequest.findMany({
        where: { requesterId: profile.id },
        orderBy: { createdAt: 'desc' },
        include: { target: { select: { id: true, avatar: true, user: { select: { pseudo: true, firstName: true, lastName: true } } } } },
      }),
    ]);

    // Associer chaque booking à sa conversationId via le message BOOKING_REQUEST
    const allIds = [...received, ...sent].map(b => b.id);
    const linkedMessages = await prisma.message.findMany({
      where: { bookingRequestId: { in: allIds }, type: 'BOOKING_REQUEST' },
      select: { bookingRequestId: true, conversationId: true },
    });
    const convMap = {};
    for (const m of linkedMessages) {
      if (m.bookingRequestId) convMap[m.bookingRequestId] = m.conversationId;
    }

    res.json({
      received: received.map(b => ({ ...b, conversationId: convMap[b.id] ?? null })),
      sent:     sent.map(b => ({ ...b, conversationId: convMap[b.id] ?? null })),
    });
  } catch (err) {
    console.error('GET booking-requests:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/events/booking-request/:id — accepter / refuser / annuler
router.patch('/booking-request/:id', requireAuth, async (req, res) => {
  const { status } = req.body;
  const allowed = ['ACCEPTED', 'DECLINED', 'CANCELLED'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const br = await prisma.bookingRequest.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        requester: { select: { id: true, userId: true, user: { select: { pseudo: true, firstName: true, lastName: true } } } },
        target:    { select: { id: true, userId: true, user: { select: { pseudo: true, firstName: true, lastName: true, role: true } } } },
      },
    });
    if (!br) return res.status(404).json({ error: 'Demande introuvable' });
    if (status === 'CANCELLED' && br.requesterId !== profile?.id) return res.status(403).json({ error: 'Non autorisé' });
    if (['ACCEPTED','DECLINED'].includes(status) && br.targetId !== profile?.id) return res.status(403).json({ error: 'Non autorisé' });

    // Mettre à jour le statut
    const updated = await prisma.bookingRequest.update({ where: { id: br.id }, data: { status } });

    const targetName    = br.target.user?.pseudo    || [br.target.user?.firstName,    br.target.user?.lastName].filter(Boolean).join(' ')    || 'Artiste';
    const requesterName = br.requester.user?.pseudo || [br.requester.user?.firstName, br.requester.user?.lastName].filter(Boolean).join(' ') || 'Organisateur';
    const dateLabel     = new Date(br.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

    // ── Effets secondaires selon le statut ──
    if (status === 'ACCEPTED') {
      // 1. Marquer l'artiste/prestataire INDISPONIBLE ce jour-là
      await prisma.availability.upsert({
        where:  { profileId_date: { profileId: br.targetId, date: br.startDate } },
        update: { status: 'UNAVAILABLE' },
        create: { profileId: br.targetId, date: br.startDate, status: 'UNAVAILABLE' },
      }).catch(() => {});

      // 2. Trouver ou créer l'événement côté organisateur
      const dayStart = br.startDate;
      const dayEnd   = new Date(new Date(br.startDate).getTime() + 24 * 60 * 60 * 1000 - 1);
      const existingEvent = await prisma.event.findFirst({
        where: { profileId: br.requesterId, start: { gte: dayStart, lte: dayEnd } },
      });

      let eventId = existingEvent?.id ?? null;

      if (existingEvent) {
        // Ajouter l'artiste comme staff de l'événement existant
        await prisma.eventStaff.create({
          data: { eventId: existingEvent.id, role: br.target.user?.role || 'ARTIST', status: 'BOOKED', profileId: br.targetId, fee: br.fee || null },
        }).catch(() => {});
      } else {
        // Créer un nouvel événement pour l'organisateur
        const newEvent = await prisma.event.create({
          data: {
            title: `Booking — ${targetName}`,
            start: br.startDate,
            status: 'PUBLISHED',
            profileId: br.requesterId,
            isPrivate: true,
            budget: br.fee || null,
          },
        });
        eventId = newEvent.id;
        await prisma.eventStaff.create({
          data: { eventId: newEvent.id, role: br.target.user?.role || 'ARTIST', status: 'BOOKED', profileId: br.targetId, fee: br.fee || null },
        }).catch(() => {});
      }

      // Lier l'événement à la demande de booking
      if (eventId) {
        await prisma.bookingRequest.update({ where: { id: br.id }, data: { eventId } }).catch(() => {});
      }

      // 3. Notification pour l'organisateur
      await prisma.notification.create({
        data: { userId: br.requester.userId, type: 'BOOKING_ACCEPTED', content: `Votre demande de booking du ${dateLabel} a été acceptée par ${targetName}.`, actorId: br.target.userId },
      }).catch(() => {});
    }

    if (status === 'DECLINED') {
      await prisma.notification.create({
        data: { userId: br.requester.userId, type: 'BOOKING_DECLINED', content: `Votre demande de booking du ${dateLabel} a été refusée par ${targetName}.`, actorId: br.target.userId },
      }).catch(() => {});
    }

    if (status === 'CANCELLED') {
      await prisma.notification.create({
        data: { userId: br.target.userId, type: 'BOOKING_CANCELLED', content: `La demande de booking du ${dateLabel} a été annulée par ${requesterName}.`, actorId: br.requester.userId },
      }).catch(() => {});
    }

    res.json({ request: updated });
  } catch (err) {
    console.error('PATCH booking-request:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/events/booking-request/:id/cancel-request — demander l'annulation d'un booking accepté
router.post('/booking-request/:id/cancel-request', requireAuth, async (req, res) => {
  const { note } = req.body;
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const br = await prisma.bookingRequest.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        requester: { select: { id: true, userId: true, user: { select: { pseudo: true, firstName: true, lastName: true } } } },
        target:    { select: { id: true, userId: true, user: { select: { pseudo: true, firstName: true, lastName: true } } } },
      },
    });
    if (!br) return res.status(404).json({ error: 'Demande introuvable' });
    if (br.status !== 'ACCEPTED') return res.status(400).json({ error: 'Seuls les bookings acceptés peuvent être annulés ainsi' });
    if (br.requesterId !== profile?.id && br.targetId !== profile?.id) return res.status(403).json({ error: 'Non autorisé' });
    if (br.cancellationRequestedBy) return res.status(400).json({ error: "Une demande d'annulation est déjà en cours" });

    // Marquer la demande d'annulation
    const updated = await prisma.bookingRequest.update({
      where: { id: br.id },
      data: { cancellationRequestedBy: profile.id, cancellationNote: note?.trim() || null },
    });

    // Trouver la conversation via le message BOOKING_REQUEST lié
    const linkedMsg = await prisma.message.findFirst({
      where: { bookingRequestId: br.id, type: 'BOOKING_REQUEST' },
      select: { conversationId: true },
    });
    if (!linkedMsg) return res.status(404).json({ error: 'Conversation introuvable' });

    const senderName = profile.id === br.requesterId
      ? (br.requester.user?.pseudo || [br.requester.user?.firstName, br.requester.user?.lastName].filter(Boolean).join(' ') || 'Utilisateur')
      : (br.target.user?.pseudo    || [br.target.user?.firstName,    br.target.user?.lastName].filter(Boolean).join(' ')    || 'Utilisateur');
    const dateLabel = new Date(br.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const content   = `🚫 Demande d'annulation du booking du ${dateLabel}${note ? `\n"${note.trim()}"` : ''}`;

    await prisma.message.create({
      data: {
        content,
        senderId:        req.user.id,
        conversationId:  linkedMsg.conversationId,
        type:            'CANCELLATION_REQUEST',
        bookingRequestId: br.id,
      },
    });
    await prisma.conversation.update({ where: { id: linkedMsg.conversationId }, data: { updatedAt: new Date() } });

    // Notification pour l'autre partie
    const otherUserId = profile.id === br.requesterId ? br.target.userId : br.requester.userId;
    await prisma.notification.create({
      data: {
        userId:  otherUserId,
        type:    'BOOKING_CANCELLATION_REQUEST',
        content: `${senderName} demande l'annulation du booking du ${dateLabel}.`,
        actorId: req.user.id,
      },
    }).catch(() => {});

    res.json({ request: updated });
  } catch (err) {
    console.error('POST booking-request cancel-request:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/events/booking-request/:id/cancel-response — répondre à une demande d'annulation
router.post('/booking-request/:id/cancel-response', requireAuth, async (req, res) => {
  const { accept } = req.body; // true = confirmer annulation, false = refuser
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const br = await prisma.bookingRequest.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        requester: { select: { id: true, userId: true, user: { select: { pseudo: true, firstName: true, lastName: true } } } },
        target:    { select: { id: true, userId: true, user: { select: { pseudo: true, firstName: true, lastName: true } } } },
      },
    });
    if (!br) return res.status(404).json({ error: 'Demande introuvable' });
    if (!br.cancellationRequestedBy) return res.status(400).json({ error: "Aucune demande d'annulation en cours" });
    if (br.cancellationRequestedBy === profile?.id) return res.status(403).json({ error: 'Vous ne pouvez pas répondre à votre propre demande' });
    if (br.requesterId !== profile?.id && br.targetId !== profile?.id) return res.status(403).json({ error: 'Non autorisé' });

    const dateLabel = new Date(br.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const cancelerUserId = br.cancellationRequestedBy === br.requesterId ? br.requester.userId : br.target.userId;

    // Trouver la conversation
    const linkedMsg = await prisma.message.findFirst({
      where: { bookingRequestId: br.id, type: 'BOOKING_REQUEST' },
      select: { conversationId: true },
    });

    if (accept) {
      const updated = await prisma.bookingRequest.update({
        where: { id: br.id },
        data: { status: 'CANCELLED', cancellationRequestedBy: null, cancellationNote: null },
      });
      await prisma.notification.create({
        data: { userId: cancelerUserId, type: 'BOOKING_CANCELLED', content: `L'annulation du booking du ${dateLabel} a été confirmée.`, actorId: req.user.id },
      }).catch(() => {});
      if (linkedMsg) {
        await prisma.message.create({
          data: { content: `✅ Annulation du booking du ${dateLabel} confirmée.`, senderId: req.user.id, conversationId: linkedMsg.conversationId, type: 'TEXT', bookingRequestId: br.id },
        });
        await prisma.conversation.update({ where: { id: linkedMsg.conversationId }, data: { updatedAt: new Date() } });
      }
      return res.json({ request: updated });
    } else {
      const updated = await prisma.bookingRequest.update({
        where: { id: br.id },
        data: { cancellationRequestedBy: null, cancellationNote: null },
      });
      await prisma.notification.create({
        data: { userId: cancelerUserId, type: 'BOOKING_CANCELLATION_DENIED', content: `L'annulation du booking du ${dateLabel} a été refusée.`, actorId: req.user.id },
      }).catch(() => {});
      if (linkedMsg) {
        await prisma.message.create({
          data: { content: `❌ Demande d'annulation du booking du ${dateLabel} refusée.`, senderId: req.user.id, conversationId: linkedMsg.conversationId, type: 'TEXT', bookingRequestId: br.id },
        });
        await prisma.conversation.update({ where: { id: linkedMsg.conversationId }, data: { updatedAt: new Date() } });
      }
      return res.json({ request: updated });
    }
  } catch (err) {
    console.error('POST booking-request cancel-response:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/events/:id — modifier un événement
router.put('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { title, description, start, end, allDay, lieu, category, isPrivate, budget, maxCapacity, status } = req.body;
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const existing = await prisma.event.findFirst({ where: { id: parseInt(id), profileId: profile?.id } });
    if (!existing) return res.status(404).json({ error: 'Événement introuvable' });
    const event = await prisma.event.update({
      where: { id: parseInt(id) },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(start !== undefined && { start: new Date(start) }),
        ...(end !== undefined && { end: end ? new Date(end) : null }),
        ...(allDay !== undefined && { allDay }),
        ...(lieu !== undefined && { lieu }),
        ...(category !== undefined && { category }),
        ...(isPrivate !== undefined && { isPrivate }),
        ...(budget !== undefined && { budget: budget ? parseFloat(budget) : null }),
        ...(maxCapacity !== undefined && { maxCapacity: maxCapacity ? parseInt(maxCapacity) : null }),
        ...(status !== undefined && { status }),
      },
    });
    res.json({ event });
  } catch (err) {
    console.error('PUT events:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/events/:id — supprimer un événement
router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const existing = await prisma.event.findFirst({ where: { id: parseInt(id), profileId: profile?.id } });
    if (!existing) return res.status(404).json({ error: 'Événement introuvable' });
    await prisma.event.delete({ where: { id: parseInt(id) } });
    res.json({ message: 'Événement supprimé' });
  } catch (err) {
    console.error('DELETE events:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
