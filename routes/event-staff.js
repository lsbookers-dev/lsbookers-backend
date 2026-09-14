// routes/event-staff.js — Gestion du personnel d'événement
// Monté dans server.js sous /api/events (même préfixe que events.js)

const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { createNotif, displayName } = require('../services/notifications');

// POST /api/events/:id/staff — ajouter un membre du personnel
router.post('/:id/staff', requireAuth, async (req, res) => {
  const { role, name, fee, notes, profileId: staffProfileId } = req.body;
  if (!role?.trim()) return res.status(400).json({ error: 'Rôle requis' });
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });

    const staff = await prisma.eventStaff.create({
      data: {
        eventId:   event.id,
        role:      role.trim(),
        name:      staffProfileId ? null : (name?.trim() || null),
        fee:       fee ? parseFloat(fee) : null,
        notes:     notes?.trim() || null,
        profileId: staffProfileId ? parseInt(staffProfileId) : null,
        // PENDING quand un profil est lié (invitation), NEEDED pour entrée manuelle
        status:    staffProfileId ? 'PENDING' : 'NEEDED',
        count:     1,
      },
      include: {
        profile: { select: { id: true, avatar: true, user: { select: { pseudo: true, firstName: true, lastName: true, role: true } } } },
      },
    });

    // Envoyer une notification d'invitation à la personne mentionnée
    if (staffProfileId) {
      const invitedProfile = await prisma.profile.findUnique({
        where: { id: parseInt(staffProfileId) },
        select: { userId: true },
      });
      if (invitedProfile) {
        await createNotif({
          userId:  invitedProfile.userId,
          type:    'STAFF_INVITATION',
          content: `${displayName(req.user)} vous invite à rejoindre l'événement "${event.title}" en tant que ${role.trim()}.`,
          actorId: req.user.id,
          staffId: staff.id,
        });
      }
    }

    res.status(201).json({ staff });
  } catch (err) {
    console.error('POST staff:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/events/:id/staff/:staffId/respond — répondre à une invitation (accept/refuse)
router.patch('/:id/staff/:staffId/respond', requireAuth, async (req, res) => {
  const { response } = req.body; // 'ACCEPT' | 'REFUSE'
  if (!['ACCEPT', 'REFUSE'].includes(response)) return res.status(400).json({ error: 'Réponse invalide (ACCEPT ou REFUSE)' });
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });

    // Vérifier que l'entrée staff existe et appartient bien à cet utilisateur
    const staffEntry = await prisma.eventStaff.findFirst({
      where: { id: parseInt(req.params.staffId), profileId: profile.id, status: 'PENDING' },
      include: {
        event: {
          include: {
            profile: { include: { user: { select: { id: true, pseudo: true, firstName: true, lastName: true } } } },
          },
        },
      },
    });
    if (!staffEntry) return res.status(404).json({ error: 'Invitation introuvable ou déjà répondue' });

    const newStatus = response === 'ACCEPT' ? 'BOOKED' : 'CANCELLED';
    const updatedStaff = await prisma.eventStaff.update({
      where: { id: staffEntry.id },
      data:  { status: newStatus },
      include: {
        profile: { select: { id: true, avatar: true, user: { select: { pseudo: true, firstName: true, lastName: true, role: true } } } },
      },
    });

    // Notifier le propriétaire de l'événement
    const eventOwnerUserId = staffEntry.event.profile?.user?.id;
    if (eventOwnerUserId) {
      const myName = displayName(req.user);
      await createNotif({
        userId:  eventOwnerUserId,
        type:    response === 'ACCEPT' ? 'STAFF_ACCEPTED' : 'STAFF_REFUSED',
        content: response === 'ACCEPT'
          ? `${myName} a accepté votre invitation pour "${staffEntry.event.title}".`
          : `${myName} a refusé votre invitation pour "${staffEntry.event.title}".`,
        actorId: req.user.id,
      });
    }

    res.json({ staff: updatedStaff, status: newStatus });
  } catch (err) {
    console.error('PATCH staff respond:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/events/:id/staff/:staffId — mettre à jour le statut (entrées manuelles uniquement)
router.patch('/:id/staff/:staffId', requireAuth, async (req, res) => {
  const { status } = req.body;
  const allowed = ['BOOKED', 'NEEDED', 'CANCELLED'];
  if (!status || !allowed.includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });

    const staff = await prisma.eventStaff.updateMany({
      where: { id: parseInt(req.params.staffId), eventId: event.id, profileId: null },
      data: { status },
    });
    if (staff.count !== 1) return res.status(404).json({ error: 'Membre introuvable ou non modifiable' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH staff:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/events/:id/staff/:staffId — retirer un membre du personnel
router.delete('/:id/staff/:staffId', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });
    const deleted = await prisma.eventStaff.deleteMany({
      where: { id: parseInt(req.params.staffId), eventId: event.id },
    });
    if (deleted.count !== 1) return res.status(404).json({ error: 'Membre introuvable' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE staff:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/events/assigned — événements où l'utilisateur est membre du personnel (BOOKED ou PENDING)
router.get('/assigned', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });

    const staffEntries = await prisma.eventStaff.findMany({
      where: { profileId: profile.id, status: { in: ['BOOKED', 'PENDING'] } },
      include: {
        event: {
          select: {
            id: true, title: true, start: true, end: true,
            allDay: true, lieu: true, category: true, status: true,
          },
        },
      },
    });

    const events = staffEntries.map(s => ({
      ...s.event,
      staffStatus: s.status, // BOOKED ou PENDING
      staffRole:   s.role,
    }));

    res.json({ events });
  } catch (err) {
    console.error('GET events/assigned:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
