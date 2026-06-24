// routes/admin.js
const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAuth, requireAdmin } = require('../middleware/auth');

/* =========================================================
 *  STATS — Récapitulatif
 *  GET /api/admin/stats/summary
 * =======================================================*/
router.get('/stats/summary', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const usersTotal  = await prisma.user.count({ where: { role: { not: 'ADMIN' } } });
    const artists     = await prisma.user.count({ where: { role: 'ARTIST' } });
    const organizers  = await prisma.user.count({ where: { role: 'ORGANIZER' } });
    const providers   = await prisma.user.count({ where: { role: 'PROVIDER' } });

    // Inscriptions aujourd'hui
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const signupsToday = await prisma.user.count({
      where: { role: { not: 'ADMIN' }, createdAt: { gte: todayStart } },
    });

    let conversations = 0, messages = 0;
    try {
      conversations = await prisma.conversation.count();
      messages      = await prisma.message.count();
    } catch { /* tables absentes */ }

    // Abonnements / paiements (tables optionnelles)
    let payingUsers = 0, mrrCents = 0, revenueMonthCents = 0, revenueOffersCents = 0;
    try {
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const activeSubs = await prisma.subscription.findMany({
        where: { status: 'ACTIVE' }, select: { priceCents: true },
      });
      payingUsers = activeSubs.length;
      mrrCents    = activeSubs.reduce((s, x) => s + (x.priceCents || 0), 0);
      const payments = await prisma.payment.findMany({
        where: { createdAt: { gte: monthStart } }, select: { amountCents: true, kind: true },
      });
      revenueMonthCents  = payments.reduce((s, p) => s + (p.amountCents || 0), 0);
      revenueOffersCents = payments.filter(p => p.kind === 'OFFER').reduce((s, p) => s + (p.amountCents || 0), 0);
    } catch { /* tables absentes */ }

    return res.json({
      summary: {
        usersTotal, artists, organizers, providers,
        signupsToday, loginsToday: 0,
        conversations, messages,
        payingUsers, mrrCents, revenueMonthCents, revenueOffersCents,
      },
    });
  } catch (err) {
    console.error('❌ /stats/summary', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  USERS — liste filtrée
 *  GET /api/admin/users?q=...&limit=50&offset=0
 * =======================================================*/
router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const qRaw  = (req.query.q || '').toString().trim();
    const limRaw = parseInt(String(req.query.limit  || ''), 10);
    const offRaw = parseInt(String(req.query.offset || ''), 10);
    const limit  = Number.isFinite(limRaw) ? Math.min(100, Math.max(1, limRaw)) : 50;
    const offset = Number.isFinite(offRaw) ? Math.max(0, offRaw) : 0;

    const where = {
      role: { not: 'ADMIN' },
      ...(qRaw ? {
        OR: [
          { pseudo:     { contains: qRaw, mode: 'insensitive' } },
          { firstName:  { contains: qRaw, mode: 'insensitive' } },
          { lastName:   { contains: qRaw, mode: 'insensitive' } },
          { email:      { contains: qRaw, mode: 'insensitive' } },
        ],
      } : {}),
    };

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          pseudo: true,
          firstName: true,
          lastName: true,
          email: true,
          role: true,
          emailVerified: true,
          createdAt: true,
          profile: { select: { id: true, avatar: true } },
        },
      }),
    ]);

    return res.json({ total, users });
  } catch (err) {
    console.error('❌ /admin/users', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  USERS — changer le rôle
 *  PATCH /api/admin/users/:id/role
 * =======================================================*/
router.patch('/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });

  const { role } = req.body;
  const ALLOWED = ['ARTIST', 'ORGANIZER', 'PROVIDER'];
  if (!ALLOWED.includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide. Valeurs acceptées : ARTIST, ORGANIZER, PROVIDER' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.role === 'ADMIN') return res.status(403).json({ error: 'Impossible de modifier un compte admin' });

    const updated = await prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, pseudo: true, email: true, role: true },
    });

    return res.json({ ok: true, user: updated });
  } catch (err) {
    console.error('❌ patch role', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  USERS — supprimer (avec gestion des FK)
 *  DELETE /api/admin/users/:id
 * =======================================================*/
router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });

  try {
    // Vérifier que ce n'est pas un admin
    const user = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.role === 'ADMIN') return res.status(403).json({ error: 'Impossible de supprimer un compte admin' });

    // Supprimer dans l'ordre pour respecter les FK
    const profile = await prisma.profile.findUnique({ where: { userId: id } });
    if (profile) await prisma.profile.delete({ where: { id: profile.id } });
    await prisma.passwordReset.deleteMany({ where: { userId: id } });
    await prisma.user.delete({ where: { id } });

    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ delete user', err);
    return res.status(500).json({ error: "Impossible de supprimer l'utilisateur" });
  }
});

module.exports = router;
