// routes/events.js — Événements, disponibilités, dépenses, achats
// Les bookings, le personnel et les documents sont dans leurs propres fichiers.

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { eventCreateSchema, eventUpdateSchema } = require('../schemas');

/* ══════════════════════════════════════════════
   ÉVÉNEMENTS — CRUD
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

// GET /api/events/all — tous mes événements (sans filtre mois)
router.get('/all', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    const events = await prisma.event.findMany({
      where: { profileId: profile.id },
      orderBy: { start: 'desc' },
      select: { id: true, title: true, start: true, end: true, lieu: true, category: true, status: true, isPrivate: true, budget: true },
    });
    res.json({ events });
  } catch (err) {
    console.error('GET events/all:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/events — créer un événement
router.post('/', requireAuth, validate(eventCreateSchema), async (req, res) => {
  const { title, description, start, end, allDay, lieu, category, isPrivate, budget, maxCapacity, status } = req.body;
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

/* ══════════════════════════════════════════════
   ÉVÉNEMENTS — DÉTAIL + SUPPRESSION + NOTES
══════════════════════════════════════════════ */

// GET /api/events/:id/detail — détail complet d'un événement (owner only)
router.get('/:id/detail', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const event = await prisma.event.findFirst({
      where: { id: parseInt(req.params.id), profileId: profile?.id },
      include: {
        staff: { include: { profile: { select: { id: true, avatar: true, user: { select: { pseudo: true, firstName: true, lastName: true, role: true } } } } } },
        expenses:  { orderBy: { createdAt: 'asc' } },
        purchases: { orderBy: { createdAt: 'asc' } },
        documents: { orderBy: { createdAt: 'asc' } },
        bookingRequests: {
          include: { target: { select: { id: true, avatar: true, user: { select: { pseudo: true, firstName: true, lastName: true, role: true } } } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });

    const dayStart = new Date(event.start);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(event.start);
    dayEnd.setHours(23, 59, 59, 999);
    const linkedBooking = await prisma.bookingRequest.findFirst({
      where: { targetId: profile?.id, status: 'ACCEPTED', startDate: { gte: dayStart, lte: dayEnd } },
      include: { requester: { select: { id: true, avatar: true, user: { select: { pseudo: true, firstName: true, lastName: true } } } } },
    });

    res.json({ event, linkedBooking: linkedBooking || null });
  } catch (err) {
    console.error('GET events/:id/detail:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/events/:id — supprimer un événement
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const existing = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile?.id } });
    if (!existing) return res.status(404).json({ error: 'Événement introuvable' });
    await prisma.event.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE events/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/events/:id/notes — mettre à jour les notes privées
router.patch('/:id/notes', requireAuth, async (req, res) => {
  const { notes } = req.body;
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const existing = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile?.id } });
    if (!existing) return res.status(404).json({ error: 'Événement introuvable' });
    const event = await prisma.event.update({ where: { id: existing.id }, data: { notes: notes ?? null } });
    res.json({ event });
  } catch (err) {
    console.error('PATCH events/:id/notes:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ══════════════════════════════════════════════
   DÉPENSES
══════════════════════════════════════════════ */

// POST /api/events/:id/expenses
router.post('/:id/expenses', requireAuth, async (req, res) => {
  const { label, amount, category } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: 'Libellé requis' });
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile?.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });
    const expense = await prisma.eventExpense.create({
      data: { eventId: event.id, label: label.trim(), amount: amount ? parseFloat(amount) : null, category: category || null },
    });
    res.status(201).json({ expense });
  } catch (err) {
    console.error('POST expenses:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/events/:id/expenses/:expenseId
router.patch('/:id/expenses/:expenseId', requireAuth, async (req, res) => {
  const { label, amount, category, paid } = req.body;
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile?.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });
    const expense = await prisma.eventExpense.update({
      where: { id: parseInt(req.params.expenseId) },
      data: {
        ...(label    !== undefined && { label: label.trim() }),
        ...(amount   !== undefined && { amount: amount ? parseFloat(amount) : null }),
        ...(category !== undefined && { category: category || null }),
        ...(paid     !== undefined && { paid: Boolean(paid) }),
      },
    });
    res.json({ expense });
  } catch (err) {
    console.error('PATCH expense:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/events/:id/expenses/:expenseId
router.delete('/:id/expenses/:expenseId', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile?.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });
    await prisma.eventExpense.delete({ where: { id: parseInt(req.params.expenseId) } });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE expense:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ══════════════════════════════════════════════
   ACHATS
══════════════════════════════════════════════ */

// POST /api/events/:id/purchases
router.post('/:id/purchases', requireAuth, async (req, res) => {
  const { item, quantity, price } = req.body;
  if (!item?.trim()) return res.status(400).json({ error: 'Article requis' });
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile?.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });
    const purchase = await prisma.eventPurchase.create({
      data: { eventId: event.id, item: item.trim(), quantity: quantity ? parseInt(quantity) : null, price: price ? parseFloat(price) : null },
    });
    res.status(201).json({ purchase });
  } catch (err) {
    console.error('POST purchase:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/events/:id/purchases/:purchaseId
router.patch('/:id/purchases/:purchaseId', requireAuth, async (req, res) => {
  const { item, quantity, price, done } = req.body;
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile?.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });
    const purchase = await prisma.eventPurchase.update({
      where: { id: parseInt(req.params.purchaseId) },
      data: {
        ...(item     !== undefined && { item: item.trim() }),
        ...(quantity !== undefined && { quantity: quantity ? parseInt(quantity) : null }),
        ...(price    !== undefined && { price: price ? parseFloat(price) : null }),
        ...(done     !== undefined && { done: Boolean(done) }),
      },
    });
    res.json({ purchase });
  } catch (err) {
    console.error('PATCH purchase:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/events/:id/purchases/:purchaseId
router.delete('/:id/purchases/:purchaseId', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile?.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });
    await prisma.eventPurchase.delete({ where: { id: parseInt(req.params.purchaseId) } });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE purchase:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/events/:id — modifier un événement
router.put('/:id', requireAuth, validate(eventUpdateSchema), async (req, res) => {
  const { id } = req.params;
  const { title, description, start, end, allDay, lieu, category, isPrivate, budget, maxCapacity, status } = req.body;
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const existing = await prisma.event.findFirst({ where: { id: parseInt(id), profileId: profile?.id } });
    if (!existing) return res.status(404).json({ error: 'Événement introuvable' });
    const event = await prisma.event.update({
      where: { id: parseInt(id) },
      data: {
        ...(title       !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(start       !== undefined && { start: new Date(start) }),
        ...(end         !== undefined && { end: end ? new Date(end) : null }),
        ...(allDay      !== undefined && { allDay }),
        ...(lieu        !== undefined && { lieu }),
        ...(category    !== undefined && { category }),
        ...(isPrivate   !== undefined && { isPrivate }),
        ...(budget      !== undefined && { budget: budget ? parseFloat(budget) : null }),
        ...(maxCapacity !== undefined && { maxCapacity: maxCapacity ? parseInt(maxCapacity) : null }),
        ...(status      !== undefined && { status }),
      },
    });
    res.json({ event });
  } catch (err) {
    console.error('PUT events:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
