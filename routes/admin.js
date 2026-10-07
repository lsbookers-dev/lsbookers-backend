// routes/admin.js
const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { adminRoleUpdateSchema } = require('../schemas');
const { deleteUserAccount } = require('../services/accountDeletion');

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

    // Connexions aujourd'hui
    let loginsToday = 0;
    try {
      loginsToday = await prisma.loginEvent.count({
        where: { createdAt: { gte: todayStart } },
      });
    } catch { /* table absente */ }

    // Utilisateurs connectés en ce moment (actifs dans les 2 dernières minutes)
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
    const onlineNow = await prisma.user.count({
      where: { role: { not: 'ADMIN' }, lastActiveAt: { gte: twoMinAgo } },
    });

    return res.json({
      summary: {
        usersTotal, artists, organizers, providers,
        signupsToday, loginsToday,
        conversations, messages,
        payingUsers, mrrCents, revenueMonthCents, revenueOffersCents,
        onlineNow,
      },
    });
  } catch (err) {
    console.error('❌ /stats/summary', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  STATS — Connexions avec filtre période
 *  GET /api/admin/stats/logins?period=day|week|month|year
 * =======================================================*/
router.get('/stats/logins', requireAuth, requireAdmin, async (req, res) => {
  try {
    const period = String(req.query.period || 'day');
    const now    = new Date();
    let start;

    switch (period) {
      case 'week':
        start = new Date(now);
        start.setDate(now.getDate() - 7);
        start.setHours(0, 0, 0, 0);
        break;
      case 'month':
        start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        break;
      case 'year':
        start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
        break;
      default: // day
        start = new Date(now);
        start.setHours(0, 0, 0, 0);
    }

    const count = await prisma.loginEvent.count({
      where: { createdAt: { gte: start } },
    });

    return res.json({ count, period });
  } catch (err) {
    console.error('❌ /stats/logins', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  STATS — Séries temporelles
 *  GET /api/admin/stats/series?days=30
 *  Retourne pour chaque jour : { date, users, revenueCents, logins }
 * =======================================================*/
router.get('/stats/series', requireAuth, requireAdmin, async (req, res) => {
  try {
    const daysRaw = parseInt(String(req.query.days || '30'), 10);
    const days    = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, daysRaw)) : 30;

    const series = [];
    const now = new Date();

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(now);
      dayStart.setDate(now.getDate() - i);
      dayStart.setHours(0, 0, 0, 0);

      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      // Nouveaux utilisateurs ce jour (hors ADMIN)
      const users = await prisma.user.count({
        where: { role: { not: 'ADMIN' }, createdAt: { gte: dayStart, lte: dayEnd } },
      });

      // Revenus ce jour (table optionnelle)
      let revenueCents = 0;
      try {
        const payments = await prisma.payment.findMany({
          where: { createdAt: { gte: dayStart, lte: dayEnd } },
          select: { amountCents: true },
        });
        revenueCents = payments.reduce((s, p) => s + (p.amountCents || 0), 0);
      } catch { /* table absente */ }

      series.push({
        date: dayStart.toISOString().split('T')[0],
        users,
        revenueCents,
        logins: 0, // non tracké pour l'instant
      });
    }

    return res.json({ series });
  } catch (err) {
    console.error('❌ /stats/series', err);
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
 *  USERS — fiche détail complète
 *  GET /api/admin/users/:id
 * =======================================================*/
router.get('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        role: true,
        isAdmin: true,
        createdAt: true,
        pseudo: true,
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        phone: true,
        countryOfResidence: true,
        emailVerified: true,
        isIdentityVerified: true,
        isPaymentEnabled: true,
        registrationStep: true,
        stripeAccountId: true,
        profile: {
          select: {
            id: true,
            bio: true,
            profession: true,
            location: true,
            country: true,
            radiusKm: true,
            specialties: true,
            styles: true,
            typeEtablissement: true,
            avatar: true,
            banner: true,
            soundcloudUrl: true,
            youtubeUrl: true,
            availableForBooking: true,
            showRealName: true,
            legalStatus: true,
            siret: true,
            organizerType: true,
            establishmentName: true,
            address: true,
            postalCode: true,
            city: true,
          },
        },
      },
    });

    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    return res.json({ user });
  } catch (err) {
    console.error('❌ GET /admin/users/:id', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  USERS — changer le rôle
 *  PATCH /api/admin/users/:id/role
 * =======================================================*/
router.patch('/users/:id/role', requireAuth, requireAdmin, validate(adminRoleUpdateSchema), async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });

  const { role } = req.body;

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
 *  USERS — supprimer (cascade manuelle complète)
 *  DELETE /api/admin/users/:id
 * =======================================================*/
router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { role: true, profile: { select: { id: true } } },
    });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.role === 'ADMIN') return res.status(403).json({ error: 'Impossible de supprimer un compte admin' });

    await deleteUserAccount(id);

    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ delete user', err);
    return res.status(500).json({ error: "Impossible de supprimer l'utilisateur" });
  }
});

module.exports = router;
