// routes/admin.js
const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticate = require('../middleware/authenticate');

// ---- helper: require ADMIN ----
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  }
  next();
}

/* =========================================================
 *  STATS — SUMMARY
 *  GET /api/admin/stats/summary
 * =======================================================*/
router.get('/stats/summary', authenticate, requireAdmin, async (req, res) => {
  try {
    // Comptes utilisateurs (sans ADMIN pour les métriques publiques)
    const usersTotal = await prisma.user.count({ where: { role: { not: 'ADMIN' } } });
    const artists     = await prisma.user.count({ where: { role: 'ARTIST' } });
    const organizers  = await prisma.user.count({ where: { role: 'ORGANIZER' } });
    const providers   = await prisma.user.count({ where: { role: 'PROVIDER' } });

    // Abonnés payants (si table Subscription existe, sinon 0)
    let payingUsers = 0;
    try {
      payingUsers = await prisma.subscription.count({ where: { status: 'ACTIVE' } });
    } catch { /* table absente → 0 */ }

    // Conversations / messages (si tables existent)
    let conversations = 0, messages = 0;
    try {
      conversations = await prisma.conversation.count();
      messages = await prisma.message.count();
    } catch { /* ignore */ }

    // Revenus (si tables Payment/Subscription existent)
    let mrrCents = 0, revenueMonthCents = 0, revenueOffersCents = 0;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    try {
      // Exemple simple : addition des payments du mois
      const payments = await prisma.payment.findMany({
        where: { createdAt: { gte: monthStart } },
        select: { amountCents: true, kind: true } // kind: 'SUBSCRIPTION' | 'OFFER'
      });
      revenueMonthCents = payments.reduce((sum, p) => sum + (p.amountCents || 0), 0);
      revenueOffersCents = payments
        .filter(p => p.kind === 'OFFER')
        .reduce((sum, p) => sum + (p.amountCents || 0), 0);

      // MRR (exemple : somme des subscriptions actives)
      const activeSubs = await prisma.subscription.findMany({
        where: { status: 'ACTIVE' },
        select: { priceCents: true }
      });
      mrrCents = activeSubs.reduce((sum, s) => sum + (s.priceCents || 0), 0);
    } catch { /* tables absentes */ }

    // Logins & signups du jour (si table LoginEvent existe, sinon 0)
    let loginsToday = 0, signupsToday = 0;
    try {
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      loginsToday = await prisma.loginEvent.count({ where: { createdAt: { gte: dayStart } } });
      signupsToday = await prisma.user.count({ where: { createdAt: { gte: dayStart }, role: { not: 'ADMIN' } } });
    } catch { /* ignore */ }

    return res.json({
      summary: {
        usersTotal, artists, organizers, providers,
        payingUsers,
        conversations, messages,
        mrrCents, revenueMonthCents, revenueOffersCents,
        loginsToday, signupsToday,
      }
    });
  } catch (err) {
    console.error('❌ /stats/summary', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  STATS — SERIES (30 jours par défaut)
 *  GET /api/admin/stats/series?days=30
 *  retourne [{ date, users, revenueCents, logins }]
 * =======================================================*/
router.get('/stats/series', authenticate, requireAdmin, async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  try {
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - (days - 1));
    start.setHours(0, 0, 0, 0);

    const byDate = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = d.toISOString().slice(0,10);
      byDate[key] = { date: key, users: 0, revenueCents: 0, logins: 0 };
    }

    // Nouveaux users/jour (sans ADMIN)
    try {
      const users = await prisma.user.findMany({
        where: { createdAt: { gte: start }, role: { not: 'ADMIN' } },
        select: { createdAt: true }
      });
      users.forEach(u => {
        const key = u.createdAt.toISOString().slice(0,10);
        if (byDate[key]) byDate[key].users += 1;
      });
    } catch {}

    // Revenus/jour (si table Payment existe)
    try {
      const pays = await prisma.payment.findMany({
        where: { createdAt: { gte: start } },
        select: { createdAt: true, amountCents: true }
      });
      pays.forEach(p => {
        const key = p.createdAt.toISOString().slice(0,10);
        if (byDate[key]) byDate[key].revenueCents += (p.amountCents || 0);
      });
    } catch {}

    // Logins/jour (si table LoginEvent existe)
    try {
      const logs = await prisma.loginEvent.findMany({
        where: { createdAt: { gte: start } },
        select: { createdAt: true }
      });
      logs.forEach(l => {
        const key = l.createdAt.toISOString().slice(0,10);
        if (byDate[key]) byDate[key].logins += 1;
      });
    } catch {}

    const series = Object.values(byDate);
    return res.json({ series });
  } catch (err) {
    console.error('❌ /stats/series', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  USERS — liste filtrée (admin invisible)
 *  GET /api/admin/users?q=...&limit=50&offset=0
 * =======================================================*/
router.get('/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const where = {
      role: { not: 'ADMIN' },
      ...(q ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ]
      } : {})
    };

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true, name: true, email: true, role: true, createdAt: true,
          profile: { select: { id: true, avatar: true, banner: true } },
          // si tu as un lien subscription
          subscription: { select: { status: true, planId: true } }
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
 *  USERS — suspendre / supprimer (exemples)
 * =======================================================*/
router.patch('/users/:id/suspend', authenticate, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    // nécessite un champ "suspended" bool sur User
    const user = await prisma.user.update({
      where: { id },
      data: { suspended: true }
    });
    return res.json({ ok: true, user });
  } catch (err) {
    console.error('❌ suspend', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/users/:id', authenticate, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    // ⚠️ à adapter selon onDelete cascade/données associées
    await prisma.user.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ delete user', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;