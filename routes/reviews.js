// routes/reviews.js
// Avis : uniquement après une prestation réellement effectuée (booking accepté
// ou poste staff confirmé, dont la date est passée), et seulement entre les
// deux parties de cette prestation. Un avis par personne et par prestation.
const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { reviewCreateSchema } = require('../schemas');
const { createNotif } = require('../services/notifications');

// Seuls les avis rattachés à une prestation sont affichés / comptés.
const VERIFIED_REVIEW = { OR: [{ bookingId: { not: null } }, { staffId: { not: null } }] };

const PERSON_SELECT = {
  id: true,
  avatar: true,
  showRealName: true,
  user: { select: { id: true, pseudo: true, firstName: true, lastName: true, role: true } },
};

// Nom public : respecte le choix « afficher mon nom et prénom » de la personne.
function publicName(profile) {
  const u = profile?.user;
  if (!u) return 'Utilisateur LSBookers';
  const realName = [u.firstName, u.lastName].filter(Boolean).join(' ');
  if (profile.showRealName && realName) return realName;
  return u.pseudo || 'Utilisateur LSBookers';
}

function publicPerson(profile) {
  return {
    profileId: profile.id,
    userId: profile.user?.id ?? null,
    role: profile.user?.role ?? null,
    name: publicName(profile),
    avatar: profile.avatar || null,
  };
}

// Date de fin effective d'une prestation
const bookingEnd = (b) => b.endDate || b.startDate;
const staffEnd = (s) => s.event.end || s.event.start;

/**
 * Prestations terminées du profil, avec la personne en face.
 * Un booking accepté crée aussi un poste staff sur l'événement : on ne garde
 * qu'une entrée par (événement, personne en face).
 */
async function finishedPrestations(profileId, now = new Date()) {
  const [bookings, staffs] = await Promise.all([
    prisma.bookingRequest.findMany({
      where: {
        status: { in: ['ACCEPTED', 'COMPLETED'] },
        OR: [{ requesterId: profileId }, { targetId: profileId }],
        AND: [{ OR: [{ endDate: { lt: now } }, { endDate: null, startDate: { lt: now } }] }],
      },
      include: {
        requester: { select: PERSON_SELECT },
        target: { select: PERSON_SELECT },
        event: { select: { title: true, status: true } },
      },
      orderBy: { startDate: 'desc' },
    }),
    prisma.eventStaff.findMany({
      where: {
        status: 'BOOKED',
        profileId: { not: null },
        event: {
          status: { not: 'CANCELLED' },
          OR: [{ end: { lt: now } }, { end: null, start: { lt: now } }],
        },
        OR: [{ profileId }, { event: { profileId } }],
      },
      include: {
        profile: { select: PERSON_SELECT },
        event: { select: { id: true, title: true, start: true, end: true, profileId: true, profile: { select: PERSON_SELECT } } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const items = new Map();
  for (const b of bookings) {
    if (b.event?.status === 'CANCELLED') continue;
    const other = b.requesterId === profileId ? b.target : b.requester;
    const key = b.eventId ? `${b.eventId}:${other.id}` : `b${b.id}`;
    items.set(key, {
      kind: 'booking', id: b.id, eventId: b.eventId ?? null,
      date: bookingEnd(b), title: b.event?.title || null, counterpart: other,
    });
  }
  for (const s of staffs) {
    const isOrganizer = s.event.profileId === profileId;
    const other = isOrganizer ? s.profile : s.event.profile;
    if (!other || other.id === profileId) continue;
    const key = `${s.eventId}:${other.id}`;
    if (items.has(key)) continue;
    items.set(key, {
      kind: 'staff', id: s.id, eventId: s.eventId,
      date: staffEnd(s), title: s.event.title || null, counterpart: other,
    });
  }
  return [...items.values()];
}

/**
 * GET /api/reviews/profile/:profileId
 * Public : avis vérifiés reçus par un profil + moyenne.
 */
router.get('/profile/:profileId', async (req, res) => {
  const profileId = Number.parseInt(req.params.profileId, 10);
  if (Number.isNaN(profileId)) {
    return res.status(400).json({ error: 'Paramètre profileId invalide' });
  }

  try {
    const where = { targetId: profileId, ...VERIFIED_REVIEW };
    const [reviews, stats] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true, rating: true, comment: true, createdAt: true,
          author: { select: PERSON_SELECT },
        },
      }),
      prisma.review.aggregate({ where, _avg: { rating: true }, _count: { rating: true } }),
    ]);

    return res.json({
      reviews: reviews.map(r => ({
        id: r.id, rating: r.rating, comment: r.comment, createdAt: r.createdAt,
        author: publicPerson(r.author),
      })),
      average: stats._avg.rating ?? null,
      count: stats._count.rating ?? 0,
    });
  } catch (error) {
    console.error('❌ Erreur récupération avis :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/reviews/pending
 * Privé : prestations terminées pour lesquelles je n'ai pas encore laissé d'avis.
 */
router.get('/pending', requireAuth, async (req, res) => {
  try {
    const me = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!me) return res.status(404).json({ error: 'Profil introuvable' });

    const prestations = await finishedPrestations(me.id);
    const given = await prisma.review.findMany({
      where: { authorId: me.id },
      select: { bookingId: true, staffId: true, targetId: true, eventId: true },
    });
    const done = (p) => given.some(r =>
      (p.kind === 'booking' && r.bookingId === p.id) ||
      (p.kind === 'staff' && r.staffId === p.id) ||
      (p.eventId != null && r.eventId === p.eventId && r.targetId === p.counterpart.id)
    );

    res.set('Cache-Control', 'private, no-store');
    return res.json({
      pending: prestations.filter(p => !done(p)).map(p => ({
        kind: p.kind, id: p.id, date: p.date, title: p.title,
        counterpart: publicPerson(p.counterpart),
      })),
    });
  } catch (error) {
    console.error('❌ Erreur avis en attente :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /api/reviews
 * Privé : laisser un avis sur la personne en face d'une prestation terminée.
 * Body : { bookingId | staffId, rating, comment? }
 */
router.post('/', requireAuth, validate(reviewCreateSchema), async (req, res) => {
  const { bookingId, staffId, rating, comment } = req.body;

  try {
    const me = await prisma.profile.findUnique({
      where: { userId: req.user.id },
      select: PERSON_SELECT,
    });
    if (!me) return res.status(404).json({ error: 'Profil auteur introuvable' });

    const prestation = (await finishedPrestations(me.id)).find(p =>
      bookingId ? (p.kind === 'booking' && p.id === bookingId) : (p.kind === 'staff' && p.id === staffId)
    );
    if (!prestation) {
      return res.status(403).json({
        error: 'Vous ne pouvez laisser un avis qu’après une prestation terminée avec cette personne.',
      });
    }

    const review = await prisma.review.create({
      data: {
        authorId: me.id,
        targetId: prestation.counterpart.id,
        rating,
        comment: comment?.trim() || null,
        eventId: prestation.eventId,
        bookingId: prestation.kind === 'booking' ? prestation.id : null,
        staffId: prestation.kind === 'staff' ? prestation.id : null,
      },
    });

    await createNotif({
      userId: prestation.counterpart.user?.id,
      type: 'NEW_REVIEW',
      content: `${publicName(me)} vous a laissé un avis (${rating}/5)`,
      actorId: req.user.id,
    });

    return res.status(201).json({ review });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Vous avez déjà laissé un avis pour cette prestation.' });
    }
    console.error('❌ Erreur création avis :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
module.exports.finishedPrestations = finishedPrestations;
module.exports.publicName = publicName;
