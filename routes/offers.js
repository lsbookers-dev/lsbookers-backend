// routes/offers.js
const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { offerCreateSchema, offerUpdateSchema } = require('../schemas');
const { createNotif, displayName } = require('../services/notifications');

/* ── Helpers ─────────────────────────────────────────────── */

function getName(user) {
  return user?.pseudo ||
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
    'Organisateur';
}

const organizerSelect = {
  id:     true,
  avatar: true,
  userId: true,
  user: {
    select: { id: true, pseudo: true, firstName: true, lastName: true },
  },
};

// Include réutilisable — on inclut event { id } pour récupérer eventId
// même si le client Prisma ne connaît pas encore le champ scalaire eventId
const offerInclude = {
  organizer:    { select: organizerSelect },
  event:        { select: { id: true } },
  _count:       { select: { applications: true } },
};

function formatOffer(o) {
  return {
    id:             o.id,
    title:          o.title,
    description:    o.description,
    type:           o.type,
    specialty:      o.specialty,
    date:           o.date,
    location:       o.location,
    country:        o.country,
    radiusKm:       o.radiusKm,
    fee:            o.fee,
    eventId:        o.event?.id ?? null,
    status:         o.status,
    createdAt:      o.createdAt,
    organizerId:    o.organizerId,
    applicantCount: o._count?.applications ?? 0,
    organizer: {
      id:     o.organizer.id,
      userId: o.organizer.userId,
      avatar: o.organizer.avatar || null,
      name:   getName(o.organizer.user),
    },
  };
}

/* ── POST /api/offers — créer une offre (ORGANIZER) ─────── */
router.post('/', requireAuth, validate(offerCreateSchema), async (req, res) => {
  const { title, description, type, specialty, date, location, country, radiusKm, fee, eventId } = req.body;

  try {
    if (req.user.role !== 'ORGANIZER') {
      return res.status(403).json({ error: 'ACCÈS_REFUSÉ' });
    }

    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } });
    if (!profile) return res.status(404).json({ error: 'PROFILE_INTROUVABLE' });

    const offerDate = new Date(date);
    if (isNaN(offerDate.getTime())) {
      return res.status(400).json({ error: 'DATE_INVALIDE' });
    }

    const eventIdInt = eventId != null ? parseInt(eventId, 10) : null;

    const offer = await prisma.offer.create({
      data: {
        title:       String(title).trim(),
        description: String(description).trim(),
        type,
        specialty:   specialty ? String(specialty).trim() : null,
        date:        offerDate,
        location:    String(location).trim(),
        country:     String(country).trim(),
        radiusKm:    radiusKm != null ? parseInt(radiusKm, 10) : null,
        fee:         fee != null ? parseFloat(fee) : null,
        status:      'ACTIVE',
        organizer:   { connect: { id: profile.id } },
        // On passe eventId via la relation (le client Prisma cache ne connaît pas le champ scalaire)
        ...(eventIdInt != null ? { event: { connect: { id: eventIdInt } } } : {}),
      },
      include: offerInclude,
    });

    // ── Notification NEW_OFFER aux abonnés artistes/prestataires concernés ──
    try {
      const organizer = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { pseudo: true, firstName: true, lastName: true },
      })
      const orgName = displayName(organizer)

      // Rôles qui peuvent être ciblés par cette offre
      const targetRoles = offer.type === 'ALL'
        ? ['ARTIST', 'PROVIDER']
        : offer.type === 'ARTIST' ? ['ARTIST'] : ['PROVIDER']

      // Récupère les abonnés qui correspondent au rôle ciblé
      const followers = await prisma.follow.findMany({
        where: { followingId: req.user.id },
        include: { follower: { select: { id: true, role: true } } },
      })

      const relevant = followers.filter(f => targetRoles.includes(f.follower?.role))
      for (const f of relevant) {
        await createNotif({
          userId:  f.follower.id,
          type:    'NEW_OFFER',
          content: `${orgName} a publié une nouvelle offre : "${offer.title}".`,
          actorId: req.user.id,
          offerId: offer.id,
        })
      }
    } catch (notifErr) {
      console.error('❌ POST /offers — erreur notifs abonnés :', notifErr.message)
    }

    return res.status(201).json(formatOffer(offer));
  } catch (err) {
    console.error('❌ POST /offers :', err);
    return res.status(500).json({ error: 'ERREUR_SERVEUR' });
  }
});

/* ── GET /api/offers — lister avec filtres ──────────────── */
router.get('/', async (req, res) => {
  const { type, specialty, location, country, organizerId, eventId } = req.query;

  try {
    const where = { status: 'ACTIVE' };

    if (type && ['ARTIST', 'PROVIDER', 'ALL'].includes(type)) where.type = type;
    if (specialty) where.specialty = { contains: specialty, mode: 'insensitive' };
    if (location)  where.location  = { contains: location,  mode: 'insensitive' };
    if (country)   where.country   = { contains: country,   mode: 'insensitive' };
    if (organizerId) where.organizerId = parseInt(organizerId, 10);
    // Filtre par eventId via la relation (pas le champ scalaire)
    if (eventId) where.event = { id: parseInt(eventId, 10) };

    const offers = await prisma.offer.findMany({
      where,
      include: offerInclude,
      orderBy: { createdAt: 'desc' },
    });

    return res.json(offers.map(formatOffer));
  } catch (err) {
    console.error('❌ GET /offers :', err);
    return res.status(500).json({ error: 'ERREUR_SERVEUR' });
  }
});

/* ── GET /api/offers/:id — une offre ───────────────────── */
router.get('/:id', async (req, res) => {
  try {
    const offer = await prisma.offer.findUnique({
      where: { id: parseInt(req.params.id, 10) },
      include: offerInclude,
    });

    if (!offer || offer.status !== 'ACTIVE') {
      return res.status(404).json({ error: 'OFFRE_INTROUVABLE' });
    }

    return res.json(formatOffer(offer));
  } catch (err) {
    console.error('❌ GET /offers/:id :', err);
    return res.status(500).json({ error: 'ERREUR_SERVEUR' });
  }
});

/* ── PUT /api/offers/:id — modifier une offre ───────────── */
router.put('/:id', requireAuth, validate(offerUpdateSchema), async (req, res) => {
  try {
    if (req.user.role !== 'ORGANIZER') return res.status(403).json({ error: 'ACCÈS_REFUSÉ' });

    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } });
    if (!profile) return res.status(404).json({ error: 'PROFILE_INTROUVABLE' });

    const offer = await prisma.offer.findUnique({ where: { id: parseInt(req.params.id, 10) } });
    if (!offer) return res.status(404).json({ error: 'OFFRE_INTROUVABLE' });
    if (offer.organizerId !== profile.id) return res.status(403).json({ error: 'ACCÈS_REFUSÉ' });

    const { title, description, type, specialty, date, location, country, radiusKm, fee, status } = req.body;
    const data = {};
    if (title)       data.title       = String(title).trim();
    if (description) data.description = String(description).trim();
    if (type && ['ARTIST', 'PROVIDER', 'ALL'].includes(type)) data.type = type;
    if (specialty !== undefined) data.specialty = specialty ? String(specialty).trim() : null;
    if (date)    data.date     = new Date(date);
    if (location) data.location = String(location).trim();
    if (country)  data.country  = String(country).trim();
    if (radiusKm !== undefined) data.radiusKm = radiusKm != null ? parseInt(radiusKm, 10) : null;
    if (fee !== undefined) data.fee = fee != null ? parseFloat(fee) : null;
    if (status && ['ACTIVE', 'CLOSED'].includes(status)) data.status = status;

    const updated = await prisma.offer.update({
      where: { id: parseInt(req.params.id, 10) },
      data,
      include: offerInclude,
    });

    return res.json(formatOffer(updated));
  } catch (err) {
    console.error('❌ PUT /offers/:id :', err);
    return res.status(500).json({ error: 'ERREUR_SERVEUR' });
  }
});

/* ── POST /api/offers/:id/apply — postuler à une offre ─── */
router.post('/:id/apply', requireAuth, async (req, res) => {
  try {
    const offerId = parseInt(req.params.id, 10);
    const { message } = req.body;

    // Récupérer l'offre avec l'organisateur
    const offer = await prisma.offer.findUnique({
      where:   { id: offerId },
      include: { organizer: { select: { id: true, userId: true } } },
    });
    if (!offer || offer.status !== 'ACTIVE') {
      return res.status(404).json({ error: 'OFFRE_INTROUVABLE' });
    }

    const applicantUserId  = req.user.id;
    const organizerUserId  = offer.organizer.userId;

    // Empêcher l'organisateur de postuler à sa propre offre
    if (applicantUserId === organizerUserId) {
      return res.status(400).json({ error: 'Vous ne pouvez pas postuler à votre propre offre.' });
    }

    // Récupérer le profil du postulant
    const applicantProfile = await prisma.profile.findUnique({ where: { userId: applicantUserId } });
    if (!applicantProfile) return res.status(404).json({ error: 'PROFILE_INTROUVABLE' });

    // Trouver ou créer la conversation
    let conversation = await prisma.conversation.findFirst({
      where: {
        AND: [
          { participants: { some: { userId: applicantUserId } } },
          { participants: { some: { userId: organizerUserId } } },
        ],
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          participants: {
            create: [{ userId: applicantUserId }, { userId: organizerUserId }],
          },
        },
      });
    }

    // Envoyer le message de candidature
    const content = message?.trim() || `Bonjour, je souhaite postuler pour l'offre "${offer.title}" que vous venez de publier. Je me tiens à votre disposition.`;
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderId:       applicantUserId,
        content,
      },
    });

    // Mettre à jour la conversation
    await prisma.conversation.update({
      where: { id: conversation.id },
      data:  { updatedAt: new Date() },
    });

    // Enregistrer la candidature (upsert pour éviter les doublons)
    await prisma.application.upsert({
      where:  { offerId_applicantId: { offerId, applicantId: applicantProfile.id } },
      create: { offerId, applicantId: applicantProfile.id, message: content },
      update: {},
    });

    // Notification à l'organisateur
    try {
      const applicantUser = await prisma.user.findUnique({
        where:  { id: applicantUserId },
        select: { pseudo: true, firstName: true, lastName: true },
      });
      await createNotif({
        userId:  organizerUserId,
        type:    'NEW_APPLICATION',
        content: `${displayName(applicantUser)} a postulé pour votre offre "${offer.title}".`,
        actorId: applicantUserId,
        offerId: offer.id,
      });
    } catch (notifErr) {
      console.error('❌ apply — erreur notif :', notifErr.message);
    }

    return res.json({ conversationId: conversation.id });
  } catch (err) {
    console.error('❌ POST /offers/:id/apply :', err);
    return res.status(500).json({ error: 'ERREUR_SERVEUR' });
  }
});

/* ── DELETE /api/offers/:id — supprimer ─────────────────── */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'ORGANIZER') return res.status(403).json({ error: 'ACCÈS_REFUSÉ' });

    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id } });
    if (!profile) return res.status(404).json({ error: 'PROFILE_INTROUVABLE' });

    const offer = await prisma.offer.findUnique({ where: { id: parseInt(req.params.id, 10) } });
    if (!offer) return res.status(404).json({ error: 'OFFRE_INTROUVABLE' });
    if (offer.organizerId !== profile.id) return res.status(403).json({ error: 'ACCÈS_REFUSÉ' });

    await prisma.offer.delete({ where: { id: parseInt(req.params.id, 10) } });
    return res.status(204).send();
  } catch (err) {
    console.error('❌ DELETE /offers/:id :', err);
    return res.status(500).json({ error: 'ERREUR_SERVEUR' });
  }
});

module.exports = router;
