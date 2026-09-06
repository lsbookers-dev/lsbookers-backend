// routes/event-staff.js — Gestion du personnel d'événement
// Monté dans server.js sous /api/events (même préfixe que events.js)

const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');

// POST /api/events/:id/staff — ajouter un membre du personnel manuellement
router.post('/:id/staff', requireAuth, async (req, res) => {
  const { role, fee, notes, profileId: staffProfileId } = req.body;
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
        fee:       fee ? parseFloat(fee) : null,
        notes:     notes?.trim() || null,
        profileId: staffProfileId ? parseInt(staffProfileId) : null,
        status:    staffProfileId ? 'BOOKED' : 'NEEDED',
        count:     1,
      },
      include: {
        profile: { select: { id: true, avatar: true, user: { select: { pseudo: true, firstName: true, lastName: true, role: true } } } },
      },
    });

    res.status(201).json({ staff });
  } catch (err) {
    console.error('POST staff:', err);
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

module.exports = router;
