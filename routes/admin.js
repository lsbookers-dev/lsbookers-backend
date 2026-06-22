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
    // Comptes par rôle (sans ADMIN dans le total “public”)
    const usersTotal = await prisma.user.count({ where: { role: { not: 'ADMIN' } } });
    const artists = await prisma.user.count({ where: { role: 'ARTIST' } });
    const organizers = await prisma.user.count({ where: { role: 'ORGANIZER' } });
    const providers = await prisma.user.count({ where: { role: 'PROVIDER' } });

    // Valeurs par défaut (si tables d’abonnement/paiement n’existent pas)
    let payingUsers = 0;
    let conversations = 0;
    let messages = 0;
    let mrrCents = 0;
    let revenueMonthCents = 0;
    let revenueOffersCents = 0;

    // Conversations / messages
    try {
      conversations = await prisma.conversation.count();
      messages = await prisma.message.count();
    } catch {
      // tables absentes : on ignore
    }

    // Abonnements / paiements
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      // Souscriptions actives (pour MRR & nombre d'abonnés)
      const activeSubs = await prisma.subscription.findMany({
        where: { status: 'ACTIVE' },
        select: { priceCents: true },
      });
      payingUsers = activeSubs.length;
      mrrCents = activeSubs.reduce((sum, s) => sum + (s.priceCents || 0), 0);

      // Paiements du mois (si table Payment existe)
      const payments = await prisma.payment.findMany({
        where: { createdAt: { gte: monthStart } },
        select: { amountCents: true, kind: true },
      });

      revenueMonthCents = payments.reduce((sum, p) => sum + (p.amountCents || 0), 0);
      revenueOffersCents = payments
        .filter((p) => p.kind === 'OFFER')
        .reduce((sum, p) => sum + (p.amountCents || 0), 0);
    } catch {
      // tables absentes : on ignore
    }

    return res.json({
      summary: {
        usersTotal,
        artists,
        organizers,
        providers,
        payingUsers,
        conversations,
        messages,
        mrrCents,
        revenueMonthCents,
        revenueOffersCents,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ /stats/summary', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  STATS — Séries (par jour)
 *  GET /api/admin/stats/series?days=30
 *  → { series: [{ date, users, revenueCents, logins }] }
 * =======================================================*/
router.get('/stats/series', requireAuth, requireAdmin, async (req, res) => {
  const daysParam = parseInt(String(req.query.days || ''), 10);
  const days = Number.isFinite(daysParam) ? Math.min(90, Math.max(1, daysParam)) : 30;

  try {
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - (days - 1));
    start.setHours(0, 0, 0, 0);

    /** Index par date */
    const byDate = {};
    for (let i = 0; i < days; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      byDate[key] = { date: key, users: 0, revenueCents: 0, logins: 0 };
    }

    // Nouveaux utilisateurs / jour (sans ADMIN)
    try {
      const users = await prisma.user.findMany({
        where: { createdAt: { gte: start }, role: { not: 'ADMIN' } },
        select: { createdAt: true },
      });
      users.forEach((u) => {
        const key = u.createdAt.toISOString().slice(0, 10);
        if (byDate[key]) byDate[key].users += 1;
      });
    } catch {
      // ignore
    }

    // Revenus / jour
    try {
      const pays = await prisma.payment.findMany({
        where: { createdAt: { gte: start } },
        select: { createdAt: true, amountCents: true },
      });
      pays.forEach((p) => {
        const key = p.createdAt.toISOString().slice(0, 10);
        if (byDate[key]) byDate[key].revenueCents += p.amountCents || 0;
      });
    } catch {
      // ignore
    }

    // Connexions / jour (si table loginEvent)
    try {
      const logs = await prisma.loginEvent.findMany({
        where: { createdAt: { gte: start } },
        select: { createdAt: true },
      });
      logs.forEach((l) => {
        const key = l.createdAt.toISOString().slice(0, 10);
        if (byDate[key]) byDate[key].logins += 1;
      });
    } catch {
      // ignore
    }

    return res.json({ series: Object.values(byDate) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ /stats/series', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  USERS — liste filtrée (admin invisible)
 *  GET /api/admin/users?q=...&limit=50&offset=0
 * =======================================================*/
router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const qRaw = (req.query.q || '').toString().trim();
    const limRaw = parseInt(String(req.query.limit || ''), 10);
    const offRaw = parseInt(String(req.query.offset || ''), 10);
    const limit = Number.isFinite(limRaw) ? Math.min(100, Math.max(1, limRaw)) : 50;
    const offset = Number.isFinite(offRaw) ? Math.max(0, offRaw) : 0;

    const where = {
      role: { not: 'ADMIN' },
      ...(qRaw
        ? {
            OR: [
              { name: { contains: qRaw, mode: 'insensitive' } },
              { email: { contains: qRaw, mode: 'insensitive' } },
            ],
          }
        : {}),
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
          name: true,
          email: true,
          role: true,
          createdAt: true,
          profile: { select: { id: true, avatar: true, banner: true } },
          // Si ta DB possède ces relations, elles seront renvoyées ;
          // sinon simplement ignorées côté code appelant.
          subscription: { select: { status: true, planId: true } },
        },
      }),
    ]);

    return res.json({ total, users });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ /admin/users', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  USERS — suspendre / supprimer
 *  (⚠️ nécessite un champ "suspended" bool dans le modèle User)
 * =======================================================*/
router.patch('/users/:id/suspend', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });

  try {
    const user = await prisma.user.update({
      where: { id },
      data: { suspended: true },
      select: { id: true, name: true, suspended: true },
    });
    return res.json({ ok: true, user });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ suspend', err);
    return res.status(500).json({ error: "Impossible de suspendre l'utilisateur (champ manquant ?)" });
  }
});

router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });

  try {
    await prisma.user.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ delete user', err);
    return res.status(500).json({ error: "Impossible de supprimer l'utilisateur" });
  }
});

module.exports = router;