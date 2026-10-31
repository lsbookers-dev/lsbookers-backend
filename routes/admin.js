// routes/admin.js
const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { deleteUserAccount } = require('../services/accountDeletion');
const { overviewNumbers } = require('../services/adminStats');
const { lateCancellationReport } = require('../services/adminWatch');
const { isProSubscription } = require('../lib/plan');

/* =========================================================
 *  ACCUEIL — à traiter + chiffres clés + 30 derniers jours
 *  GET /api/admin/overview
 * =======================================================*/
router.get('/overview', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [numbers, carousel, otherOrders, unreadContact, watch] = await Promise.all([
      overviewNumbers(),
      prisma.extraOrder.count({ where: { status: 'PAID', kind: 'CAROUSEL' } }),
      prisma.extraOrder.count({ where: { status: 'PAID', kind: { not: 'CAROUSEL' } } }),
      prisma.contactMessage.count({ where: { isRead: false, isArchived: false } }),
      lateCancellationReport(),
    ]);
    const toWatch = watch.alerts.filter(a => a.needsDecision);
    return res.json({
      todo: {
        carouselOrders: carousel,
        otherOrders,
        unreadContact,
        watchMembers: toWatch.map(a => ({ userId: a.userId, name: a.name, count: a.count })),
      },
      ...numbers,
    });
  } catch (err) {
    console.error('❌ /admin/overview', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  PASTILLES DU MENU — Membres (à surveiller), Ventes (à valider), Messages (non lus)
 *  GET /api/admin/badges
 * =======================================================*/
router.get('/badges', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [orders, unreadContact, watch] = await Promise.all([
      prisma.extraOrder.count({ where: { status: 'PAID' } }),
      prisma.contactMessage.count({ where: { isRead: false, isArchived: false } }),
      lateCancellationReport(),
    ]);
    return res.json({ members: watch.alerts.filter(a => a.needsDecision).length, sales: orders, messages: unreadContact });
  } catch (err) {
    console.error('❌ /admin/badges', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  HISTORIQUE — journal des actions admin
 *  GET /api/admin/logs?action=USER_DELETE,USER_BAN&q=texte&before=<id>&limit=50
 * =======================================================*/
router.get('/logs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limRaw = parseInt(String(req.query.limit || ''), 10);
    const limit = Number.isFinite(limRaw) ? Math.min(100, Math.max(1, limRaw)) : 50;
    const before = parseInt(String(req.query.before || ''), 10);
    const actions = String(req.query.action || '').split(',').map(a => a.trim()).filter(a => /^[A-Z_]{3,40}$/.test(a));
    const q = String(req.query.q || '').trim().slice(0, 100);
    const where = {
      ...(Number.isFinite(before) ? { id: { lt: before } } : {}),
      ...(actions.length ? { action: { in: actions } } : {}),
      ...(q ? { targetLabel: { contains: q, mode: 'insensitive' } } : {}),
    };
    const logs = await prisma.adminLog.findMany({ where, orderBy: { id: 'desc' }, take: limit + 1 });
    const hasMore = logs.length > limit;
    const page = logs.slice(0, limit);
    return res.json({ logs: page, nextBefore: hasMore ? page[page.length - 1].id : null });
  } catch (err) {
    console.error('❌ /admin/logs', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  MEMBRES — liste filtrée
 *  GET /api/admin/users?q=&role=ARTIST|ORGANIZER|PROVIDER&plan=free|pro|business&status=banned|unverified|watch&limit=50&offset=0
 * =======================================================*/
const PRO_ACTIVE = (now) => ({
  OR: [
    { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } },
    { status: 'CANCELLED', currentPeriodEnd: { gt: now } },
  ],
  AND: [{ OR: [{ endDate: null }, { endDate: { gt: now } }] }],
});

router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const qRaw  = (req.query.q || '').toString().trim();
    const limRaw = parseInt(String(req.query.limit  || ''), 10);
    const offRaw = parseInt(String(req.query.offset || ''), 10);
    const limit  = Number.isFinite(limRaw) ? Math.min(100, Math.max(1, limRaw)) : 50;
    const offset = Number.isFinite(offRaw) ? Math.max(0, offRaw) : 0;
    const role = ['ARTIST', 'ORGANIZER', 'PROVIDER'].includes(String(req.query.role)) ? String(req.query.role) : null;
    const plan = String(req.query.plan || '');
    const status = String(req.query.status || '');
    const now = new Date();

    const and = [{ role: role || { not: 'ADMIN' } }];
    if (qRaw) {
      and.push({ OR: [
        { pseudo:     { contains: qRaw, mode: 'insensitive' } },
        { firstName:  { contains: qRaw, mode: 'insensitive' } },
        { lastName:   { contains: qRaw, mode: 'insensitive' } },
        { email:      { contains: qRaw, mode: 'insensitive' } },
      ] });
    }
    if (plan === 'business') and.push({ OR: [{ canManageProfiles: true }, { agencySubscription: PRO_ACTIVE(now) }] });
    if (plan === 'pro') and.push({ subscription: PRO_ACTIVE(now) });
    if (plan === 'free') and.push({ canManageProfiles: false }, { NOT: { subscription: PRO_ACTIVE(now) } }, { NOT: { agencySubscription: PRO_ACTIVE(now) } });
    if (status === 'banned') and.push({ bannedAt: { not: null } });
    if (status === 'unverified') and.push({ emailVerified: false });
    if (status === 'watch') {
      const report = await lateCancellationReport();
      and.push({ id: { in: report.alerts.map(a => a.userId) } });
    }
    const where = { AND: and };

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
          canManageProfiles: true,
          bannedAt: true,
          pausedAt: true,
          createdAt: true,
          lastActiveAt: true,
          profile: { select: { id: true, avatar: true, city: true, location: true } },
          subscription: { select: { status: true, source: true, endDate: true, currentPeriodEnd: true } },
          agencySubscription: { select: { status: true, endDate: true, currentPeriodEnd: true } },
        },
      }),
    ]);

    return res.json({
      total,
      users: users.map(({ subscription, agencySubscription, ...u }) => ({
        ...u,
        plan: u.canManageProfiles || isProSubscription(agencySubscription) ? 'BUSINESS' : isProSubscription(subscription) ? 'PRO' : 'FREE',
        planSource: u.canManageProfiles && !isProSubscription(agencySubscription) ? 'ADMIN' : (isProSubscription(subscription) ? subscription.source : null),
      })),
    });
  } catch (err) {
    console.error('❌ /admin/users', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  MEMBRES — fiche complète (toutes les informations du compte, sauf les secrets)
 *  GET /api/admin/users/:id
 * =======================================================*/
const USER_SECRETS = { password: true, emailVerificationToken: true, pendingEmailTokenHash: true, tokenVersion: true };

router.get('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      omit: USER_SECRETS,
      include: {
        profile: {
          include: {
            _count: {
              select: {
                publications: true, events: true, offers: true, albums: true,
                bookingRequestsSent: true, bookingRequestsReceived: true,
                reviewsGiven: true, reviewsReceived: true, applicationsSubmitted: true,
              },
            },
            managers: {
              where: { status: { in: ['PENDING', 'ACTIVE'] } },
              select: { status: true, manager: { select: { id: true, email: true, pseudo: true, firstName: true, lastName: true } } },
            },
          },
        },
        subscription: true,
        agencySubscription: true,
        managedProfiles: {
          where: { status: { in: ['PENDING', 'ACTIVE'] } },
          select: { id: true, status: true, profile: { select: { id: true, user: { select: { id: true, pseudo: true, firstName: true, lastName: true, email: true } } } } },
        },
        sessions: { orderBy: { lastUsedAt: 'desc' }, take: 5, select: { name: true, createdAt: true, lastUsedAt: true, revokedAt: true } },
        extraOrders: { orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, label: true, status: true, amountCents: true, paidAt: true, createdAt: true } },
        promoRedemptions: { select: { createdAt: true, code: { select: { code: true, kind: true } } } },
        _count: { select: { followers: true, following: true, messages: true, loginEvents: true } },
      },
    });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const [adminLogs, watch] = await Promise.all([
      prisma.adminLog.findMany({ where: { targetUserId: id }, orderBy: { id: 'desc' }, take: 20 }),
      lateCancellationReport().then(r => r.alerts.find(a => a.userId === id) || null).catch(() => null),
    ]);
    return res.json({
      user: {
        ...user,
        plan: user.canManageProfiles || isProSubscription(user.agencySubscription) ? 'BUSINESS' : isProSubscription(user.subscription) ? 'PRO' : 'FREE',
      },
      lateCancellations: watch,
      adminLogs,
    });
  } catch (err) {
    console.error('❌ GET /admin/users/:id', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* =========================================================
 *  USERS — gestion de plusieurs profils (agent, plusieurs salles)
 *  PATCH /api/admin/users/:id/manage-profiles { enabled }
 *  En attendant la formule Agence, l'admin active la fonction à la main.
 * =======================================================*/
router.patch('/users/:id/manage-profiles', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Choix invalide' });
  try {
    const updated = await prisma.user.update({
      where: { id },
      data: { canManageProfiles: req.body.enabled },
      select: { id: true, canManageProfiles: true },
    });
    // Ses artistes gérés : leur propre Pro est suspendu ou relancé selon la formule
    await require('../services/agency').onAgencyChanged(id);
    return res.json({ ok: true, user: updated });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Utilisateur introuvable' });
    console.error('❌ patch manage-profiles', err);
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
