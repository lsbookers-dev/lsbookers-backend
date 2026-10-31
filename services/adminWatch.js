// services/adminWatch.js — Membres « à surveiller » de l'admin : annulations tardives répétées
// (par la personne bookée elle-même) et comptes suspendus. Utilisé par Admin › Membres et Accueil.
const prisma = require('../prisma/client')
const { getPlanSettings } = require('../lib/planSettings')

const userName = (u) => u?.pseudo || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.email || 'Utilisateur'
const USER_SELECT = { id: true, email: true, pseudo: true, firstName: true, lastName: true, role: true }

async function lateCancellationReport() {
  const settings = await getPlanSettings()
  const since = new Date(Date.now() - settings.lateCancellations.windowDays * 24 * 60 * 60 * 1000)
  const groups = await prisma.bookingRequest.groupBy({
    by: ['targetId'],
    where: { lateCancellation: true, cancelledAt: { gte: since } },
    _count: { _all: true },
  })
  const relevant = groups.filter(g => g._count._all >= settings.lateCancellations.warnAt)
  const profiles = await prisma.profile.findMany({
    where: { id: { in: relevant.map(g => g.targetId) } },
    select: { id: true, avatar: true, user: { select: { ...USER_SELECT, bannedAt: true, banReason: true, lateCancelWarnedAt: true } } },
  })
  // Seules les annulations faites par la personne bookée elle-même comptent
  const counts = await Promise.all(profiles.map(p => prisma.bookingRequest.findMany({
    where: { targetId: p.id, cancelledById: p.id, lateCancellation: true, cancelledAt: { gte: since } },
    select: { id: true, startDate: true, cancelledAt: true }, orderBy: { cancelledAt: 'desc' },
  })))
  const alerts = profiles.map((p, i) => ({
    userId: p.user.id, name: userName(p.user), email: p.user.email, role: p.user.role, avatar: p.avatar,
    count: counts[i].length, cancellations: counts[i],
    warnedAt: p.user.lateCancelWarnedAt, bannedAt: p.user.bannedAt, banReason: p.user.banReason,
    needsDecision: counts[i].length >= settings.lateCancellations.alertAt && !p.user.bannedAt,
  })).filter(x => x.count >= settings.lateCancellations.warnAt || x.bannedAt)
  alerts.sort((a, b) => Number(b.needsDecision) - Number(a.needsDecision) || b.count - a.count)
  const banned = await prisma.user.findMany({ where: { bannedAt: { not: null } }, select: { ...USER_SELECT, bannedAt: true, banReason: true } })
  return {
    alerts,
    banned: banned.map(u => ({ userId: u.id, name: userName(u), email: u.email, bannedAt: u.bannedAt, banReason: u.banReason })),
    rules: settings.lateCancellations,
  }
}

module.exports = { lateCancellationReport }
