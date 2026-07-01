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

/* ══════════════════════════════════════════════
   DISPONIBILITÉS
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

module.exports = router;
