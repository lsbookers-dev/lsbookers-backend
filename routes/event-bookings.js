// routes/event-bookings.js — Demandes de booking
// Monté dans server.js sous /api/events (même préfixe que events.js)

const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { createNotif, displayName } = require('../services/notifications');
const { checkLimit } = require('../lib/plan');
const { onBookingCancelled } = require('../services/bookingPayments');
const { closeOffer } = require('./offers');

/**
 * Rattache un booking accepté à l'événement de l'organisateur :
 * - l'événement choisi lors de la demande s'il appartient à l'organisateur,
 * - sinon un événement de l'organisateur le même jour,
 * - sinon un nouvel événement privé « Booking — <artiste> ».
 * Ajoute l'artiste/prestataire au personnel (BOOKED) s'il n'y est pas déjà.
 */
async function attachBookingToOrganizerEvent(br, targetName) {
  const bookingDay = new Date(br.startDate);
  bookingDay.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(bookingDay.getTime() + 24 * 60 * 60 * 1000 - 1);

  let event = br.eventId
    ? await prisma.event.findFirst({ where: { id: br.eventId, profileId: br.requesterId } })
    : null;
  if (!event) {
    event = await prisma.event.findFirst({
      where: { profileId: br.requesterId, start: { gte: bookingDay, lte: dayEnd } },
      orderBy: { start: 'asc' },
    });
  }
  if (!event) {
    event = await prisma.event.create({
      data: { title: `Booking — ${targetName}`, start: br.startDate, status: 'PUBLISHED', profileId: br.requesterId, isPrivate: true, budget: br.fee || null },
    });
  }

  const existingStaff = await prisma.eventStaff.findFirst({ where: { eventId: event.id, profileId: br.targetId } });
  if (existingStaff) {
    if (existingStaff.status !== 'BOOKED' || (existingStaff.fee == null && br.fee != null)) {
      await prisma.eventStaff.update({
        where: { id: existingStaff.id },
        data: { status: 'BOOKED', fee: existingStaff.fee ?? br.fee ?? null },
      });
    }
  } else {
    await prisma.eventStaff.create({
      data: { eventId: event.id, role: br.target.user?.role || 'ARTIST', status: 'BOOKED', profileId: br.targetId, fee: br.fee || null },
    });
  }
  return event.id;
}

// POST /api/events/booking-request — envoyer une demande de booking
router.post('/booking-request', requireAuth, async (req, res) => {
  const { targetProfileId, date, message, fee, offerId, closeOfferOnAccept } = req.body;
  let { eventId } = req.body;
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

    // Compte gratuit : demandes de booking limitées par mois
    const limited = await checkLimit(req.user, 'bookingRequestsPerMonth', { profileId: requesterProfile.id });
    if (limited) return res.status(403).json(limited);

    // Booking proposé depuis une candidature : l'offre doit être à l'auteur de la demande
    let linkedOffer = null;
    if (offerId) {
      linkedOffer = await prisma.offer.findUnique({ where: { id: parseInt(offerId, 10) }, select: { id: true, organizerId: true, eventId: true, status: true } });
      if (!linkedOffer || linkedOffer.organizerId !== requesterProfile.id) return res.status(403).json({ error: 'Offre introuvable' });
      if (!eventId && linkedOffer.eventId) eventId = linkedOffer.eventId;
    }

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
        offerId:     linkedOffer?.id ?? null,
        closeOfferOnAccept: !!(linkedOffer && closeOfferOnAccept),
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
    const msgContent = `Proposition de booking pour le ${dateLabel}${fee ? ` · Cachet proposé : ${parseFloat(fee).toLocaleString('fr-FR')} €` : ''}${message ? `\n"${message.trim()}"` : ''}`;

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

    // Booking déjà accepté puis annulé : remboursement / annulation tardive selon les règles
    if (status === 'CANCELLED' && br.status === 'ACCEPTED') {
      await onBookingCancelled(br.id, profile.id).catch(err => console.error('onBookingCancelled:', err));
    }

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

      await prisma.availability.upsert({
        where:  { profileId_date: { profileId: br.targetId, date: bookingDay } },
        update: { status: 'UNAVAILABLE' },
        create: { profileId: br.targetId, date: bookingDay, status: 'UNAVAILABLE' },
      });

      // Un seul événement : celui de l'organisateur. L'artiste/prestataire y est ajouté
      // comme membre du personnel (BOOKED) et le voit dans son agenda avec la vue « booké ».
      const eventId = await attachBookingToOrganizerEvent(br, targetName);
      if (eventId && eventId !== br.eventId) {
        await prisma.bookingRequest.update({ where: { id: br.id }, data: { eventId } }).catch(() => {});
      }

      await createNotif({
        userId:    br.requester.userId,
        type:      'BOOKING_ACCEPTED',
        content:   `Votre proposition de booking du ${dateLabel} a été acceptée par ${targetName}.`,
        actorId:   br.target.userId,
        messageId: linkedMsgId,
      });

      // Booking proposé depuis une offre avec « clôturer à l'acceptation » : l'offre est clôturée
      if (br.offerId && br.closeOfferOnAccept) {
        const closed = await closeOffer(br.offerId, { actorUserId: br.requester.userId, keepProfileId: br.targetId });
        if (closed) {
          // Confirmation pour l'organisateur : le clic ouvre le booking dans l'agenda
          await createNotif({
            userId:  br.requester.userId,
            type:    'OFFER_FILLED',
            content: `Booking confirmé avec ${targetName} : votre offre « ${closed.title} » est clôturée, les autres candidats ont été prévenus.`,
            offerId: closed.id,
            eventId: eventId || br.eventId || undefined,
          });
        }
      }

      // Offre encore en ligne pour ce besoin (même événement, ou offre à laquelle la personne a postulé) :
      // on propose à l'organisateur de la clôturer
      const openOffers = await prisma.offer.findMany({
        where: {
          organizerId: br.requesterId,
          status: 'ACTIVE',
          OR: [
            ...(eventId ? [{ eventId }] : []),
            { applications: { some: { applicantId: br.targetId } } },
          ],
        },
        select: { id: true, title: true },
      });
      for (const o of openOffers) {
        await createNotif({
          userId:  br.requester.userId,
          eventId: eventId || br.eventId || undefined,
          type:    'OFFER_TO_CLOSE',
          content: `Booking confirmé avec ${targetName} : votre offre « ${o.title} » est toujours en ligne. Clôturez-la pour ne plus recevoir de candidatures.`,
          offerId: o.id,
        });
      }
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

    // Booking payé en ligne : l'annulation est immédiate, les règles de remboursement s'appliquent
    // d'elles-mêmes (LS Bookers n'arbitre pas, et l'autre partie ne peut pas bloquer l'annulation)
    if (br.paymentMode === 'ONLINE') {
      const cancelled = await prisma.bookingRequest.update({
        where: { id: br.id },
        data: { status: 'CANCELLED', cancellationRequestedBy: null, cancellationNote: null },
      });
      const result = await onBookingCancelled(br.id, profile.id);
      const who = profile.id === br.requesterId ? br.requester.user : br.target.user;
      const whoName = who?.pseudo || [who?.firstName, who?.lastName].filter(Boolean).join(' ') || 'Utilisateur';
      const dateLabel = new Date(br.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
      const conv = await prisma.message.findFirst({ where: { bookingRequestId: br.id, type: 'BOOKING_REQUEST' }, select: { id: true, conversationId: true } });
      if (conv) {
        await prisma.message.create({
          data: { content: `Booking du ${dateLabel} annulé par ${whoName}${note ? `\n"${note.trim()}"` : ''}`, senderId: req.user.id, conversationId: conv.conversationId, type: 'TEXT', bookingRequestId: br.id },
        });
        await prisma.conversation.update({ where: { id: conv.conversationId }, data: { updatedAt: new Date() } });
      }
      await createNotif({
        userId: profile.id === br.requesterId ? br.target.userId : br.requester.userId,
        type: 'BOOKING_CANCELLED',
        content: `Le booking du ${dateLabel} a été annulé par ${whoName}.`,
        actorId: req.user.id,
        messageId: conv?.id,
      });
      return res.json({ request: cancelled, cancelled: true, late: result?.late ?? false });
    }

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
    const content   = `Demande d'annulation du booking du ${dateLabel}${note ? `\n"${note.trim()}"` : ''}`;

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
      // Annulation tardive comptée pour celui qui l'a demandée ; remboursement si payé en ligne
      await onBookingCancelled(br.id, br.cancellationRequestedBy).catch(err => console.error('onBookingCancelled:', err));
      await createNotif({
        userId:    cancelerUserId,
        type:      'CANCELLATION_ACCEPTED',
        content:   `L'annulation du booking du ${dateLabel} a été confirmée.`,
        actorId:   req.user.id,
        messageId: linkedMsg?.id,
      });
      if (linkedMsg) {
        await prisma.message.create({
          data: { content: `Annulation du booking du ${dateLabel} confirmée.`, senderId: req.user.id, conversationId: linkedMsg.conversationId, type: 'TEXT', bookingRequestId: br.id },
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
          data: { content: `Demande d'annulation du booking du ${dateLabel} refusée.`, senderId: req.user.id, conversationId: linkedMsg.conversationId, type: 'TEXT', bookingRequestId: br.id },
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
module.exports.attachBookingToOrganizerEvent = attachBookingToOrganizerEvent;
