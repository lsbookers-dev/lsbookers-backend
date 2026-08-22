// routes/event-bookings.js — Demandes de booking
// Monté dans server.js sous /api/events (même préfixe que events.js)

const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { createNotif, displayName } = require('../services/notifications');

// POST /api/events/booking-request — envoyer une demande de booking
router.post('/booking-request', requireAuth, async (req, res) => {
  const { targetProfileId, date, message, fee, eventId } = req.body;
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
        eventId:     eventId ? parseInt(eventId) : null,
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
    const msgContent = `📅 Proposition de booking pour le ${dateLabel}${fee ? ` · Cachet proposé : ${parseFloat(fee).toLocaleString('fr-FR')} €` : ''}${message ? `\n"${message.trim()}"` : ''}`;

    await prisma.message.create({
      data: {
        content:          msgContent,
        senderId:         req.user.id,
        conversationId:   conversation.id,
        type:             'BOOKING_REQUEST',
        bookingRequestId: bookingRequest.id,
      },
    });

    await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });

    // 4. Notification pour la cible (avec lien vers la conversation)
    const senderName = displayName(requesterProfile.user);
    const linkedMessage = await prisma.message.findFirst({
      where: { bookingRequestId: bookingRequest.id, type: 'BOOKING_REQUEST' },
      select: { id: true },
    });
    await createNotif({
      userId:    targetProfile.userId,
      type:      'BOOKING_REQUEST',
      content:   `Nouvelle proposition de booking du ${dateLabel} de ${senderName}.`,
      actorId:   req.user.id,
      messageId: linkedMessage?.id,
    });

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
    if (['ACCEPTED', 'DECLINED'].includes(status) && br.targetId !== profile?.id) return res.status(403).json({ error: 'Non autorisé' });

    const updated = await prisma.bookingRequest.update({ where: { id: br.id }, data: { status } });

    const targetName    = br.target.user?.pseudo    || [br.target.user?.firstName,    br.target.user?.lastName].filter(Boolean).join(' ')    || 'Artiste';
    const requesterName = br.requester.user?.pseudo || [br.requester.user?.firstName, br.requester.user?.lastName].filter(Boolean).join(' ') || 'Organisateur';
    const dateLabel     = new Date(br.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

    // Retrouver le message BOOKING_REQUEST pour lier la notification à la conversation
    const linkedMsg = await prisma.message.findFirst({
      where: { bookingRequestId: br.id, type: 'BOOKING_REQUEST' },
      select: { id: true },
    });
    const linkedMsgId = linkedMsg?.id;

    if (status === 'ACCEPTED') {
      const bookingDay = new Date(br.startDate);
      bookingDay.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(bookingDay.getTime() + 24 * 60 * 60 * 1000 - 1);

      await prisma.availability.upsert({
        where:  { profileId_date: { profileId: br.targetId, date: bookingDay } },
        update: { status: 'UNAVAILABLE' },
        create: { profileId: br.targetId, date: bookingDay, status: 'UNAVAILABLE' },
      });

      const existingOrgEvent = await prisma.event.findFirst({
        where: { profileId: br.requesterId, start: { gte: bookingDay, lte: dayEnd } },
      });
      let eventId = existingOrgEvent?.id ?? null;

      if (existingOrgEvent) {
        await prisma.eventStaff.create({
          data: { eventId: existingOrgEvent.id, role: br.target.user?.role || 'ARTIST', status: 'BOOKED', profileId: br.targetId, fee: br.fee || null },
        }).catch(() => {});
      } else {
        const orgEvent = await prisma.event.create({
          data: { title: `Booking — ${targetName}`, start: br.startDate, status: 'PUBLISHED', profileId: br.requesterId, isPrivate: true, budget: br.fee || null },
        });
        eventId = orgEvent.id;
        await prisma.eventStaff.create({
          data: { eventId: orgEvent.id, role: br.target.user?.role || 'ARTIST', status: 'BOOKED', profileId: br.targetId, fee: br.fee || null },
        }).catch(() => {});
      }

      const existingArtistEvent = await prisma.event.findFirst({
        where: { profileId: br.targetId, start: { gte: bookingDay, lte: dayEnd } },
      });
      if (!existingArtistEvent) {
        await prisma.event.create({
          data: { title: `Booking — ${requesterName}`, start: br.startDate, status: 'PUBLISHED', profileId: br.targetId, isPrivate: true, budget: br.fee || null },
        });
      }

      if (eventId) {
        await prisma.bookingRequest.update({ where: { id: br.id }, data: { eventId } }).catch(() => {});
      }

      await createNotif({
        userId:    br.requester.userId,
        type:      'BOOKING_ACCEPTED',
        content:   `Votre proposition de booking du ${dateLabel} a été acceptée par ${targetName}.`,
        actorId:   br.target.userId,
        messageId: linkedMsgId,
      });
    }

    if (status === 'DECLINED') {
      await createNotif({
        userId:    br.requester.userId,
        type:      'BOOKING_DECLINED',
        content:   `Votre proposition de booking du ${dateLabel} a été refusée par ${targetName}.`,
        actorId:   br.target.userId,
        messageId: linkedMsgId,
      });
    }

    if (status === 'CANCELLED') {
      await createNotif({
        userId:    br.target.userId,
        type:      'BOOKING_CANCELLED',
        content:   `La proposition de booking du ${dateLabel} a été annulée par ${requesterName}.`,
        actorId:   br.requester.userId,
        messageId: linkedMsgId,
      });
    }

    res.json({ request: updated });
  } catch (err) {
    console.error('PATCH booking-request:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/events/booking-request/:id/payment-status
router.patch('/booking-request/:id/payment-status', requireAuth, async (req, res) => {
  const { paymentStatus } = req.body;
  const allowed = ['UNPAID', 'DEPOSIT', 'PAID', 'DIRECT'];
  if (!allowed.includes(paymentStatus)) return res.status(400).json({ error: 'Statut de paiement invalide' });
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const br = await prisma.bookingRequest.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!br) return res.status(404).json({ error: 'Demande introuvable' });
    if (br.requesterId !== profile?.id) return res.status(403).json({ error: 'Non autorisé' });
    const updated = await prisma.bookingRequest.update({ where: { id: br.id }, data: { paymentStatus } });
    res.json({ request: updated });
  } catch (err) {
    console.error('PATCH booking-request payment-status:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/events/booking-request/:id/cancel-request
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

    const updated = await prisma.bookingRequest.update({
      where: { id: br.id },
      data: { cancellationRequestedBy: profile.id, cancellationNote: note?.trim() || null },
    });

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
      data: { content, senderId: req.user.id, conversationId: linkedMsg.conversationId, type: 'CANCELLATION_REQUEST', bookingRequestId: br.id },
    });
    await prisma.conversation.update({ where: { id: linkedMsg.conversationId }, data: { updatedAt: new Date() } });

    const otherUserId = profile.id === br.requesterId ? br.target.userId : br.requester.userId;
    const cancelLinkedMsg = await prisma.message.findFirst({
      where: { bookingRequestId: br.id, type: 'BOOKING_REQUEST' },
      select: { id: true },
    });
    await createNotif({
      userId:    otherUserId,
      type:      'CANCELLATION_REQUEST',
      content:   `${senderName} demande l'annulation du booking du ${dateLabel}.`,
      actorId:   req.user.id,
      messageId: cancelLinkedMsg?.id,
    });

    res.json({ request: updated });
  } catch (err) {
    console.error('POST booking-request cancel-request:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/events/booking-request/:id/cancel-response
router.post('/booking-request/:id/cancel-response', requireAuth, async (req, res) => {
  const { accept } = req.body;
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

    const linkedMsg = await prisma.message.findFirst({
      where: { bookingRequestId: br.id, type: 'BOOKING_REQUEST' },
      select: { conversationId: true },
    });

    if (accept) {
      const updated = await prisma.bookingRequest.update({
        where: { id: br.id },
        data: { status: 'CANCELLED', cancellationRequestedBy: null, cancellationNote: null },
      });
      await createNotif({
        userId:    cancelerUserId,
        type:      'CANCELLATION_ACCEPTED',
        content:   `L'annulation du booking du ${dateLabel} a été confirmée.`,
        actorId:   req.user.id,
        messageId: linkedMsg?.id,
      });
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
      await createNotif({
        userId:    cancelerUserId,
        type:      'CANCELLATION_DECLINED',
        content:   `L'annulation du booking du ${dateLabel} a été refusée.`,
        actorId:   req.user.id,
        messageId: linkedMsg?.id,
      });
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

module.exports = router;
