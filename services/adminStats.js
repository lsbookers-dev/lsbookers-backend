// services/adminStats.js — Chiffres de l'admin (Accueil et Ventes), calculés au même endroit pour
// qu'ils soient identiques partout : abonnés Pro et Business, revenu mensuel, ventes du mois.
const prisma = require('../prisma/client')
const { isProSubscription } = require('../lib/plan')

const userName = (u) => u?.pseudo || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.email || 'Utilisateur'
const USER_SELECT = { id: true, email: true, pseudo: true, firstName: true, lastName: true, role: true }

/** Abonnés Pro et Business (un Pro offert compte comme Pro, sans revenu) */
async function subscriptionOverview({ take = 500 } = {}) {
  const [subs, agencies] = await Promise.all([
    prisma.subscription.findMany({ orderBy: { updatedAt: 'desc' }, include: { user: { select: USER_SELECT } }, take }),
    prisma.agencySubscription.findMany({ orderBy: { updatedAt: 'desc' }, include: { user: { select: USER_SELECT } }, take }),
  ])
  const row = (s, plan) => ({
    id: `${plan}-${s.id}`, plan, status: s.status, interval: s.interval, source: s.source || 'STRIPE', priceCents: s.priceCents, promoCode: s.promoCode,
    trialEndsAt: s.trialEndsAt, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, startDate: s.startDate,
    extraProfiles: s.extraProfiles ?? 0, pausedByAgency: !!s.pausedByAgency,
    isPro: isProSubscription(s), user: { id: s.user.id, name: userName(s.user), email: s.user.email, role: s.user.role },
  })
  const list = [...agencies.map(s => row(s, 'BUSINESS')), ...subs.map(s => row(s, 'PRO'))]
  // Payant = abonnement Stripe actif dont le membre paie lui-même (pas suspendu par une agence)
  const paying = list.filter(s => s.isPro && s.source === 'STRIPE' && s.status === 'ACTIVE' && !s.pausedByAgency)
  // Revenu mensuel : un abonnement annuel compte pour 1/12 de son prix
  const mrrCents = paying.reduce((sum, s) => sum + (s.interval === 'YEAR' ? Math.round(s.priceCents / 12) : s.priceCents), 0)
  return {
    list,
    totals: {
      pro: list.filter(s => s.plan === 'PRO' && s.isPro).length,
      business: list.filter(s => s.plan === 'BUSINESS' && s.isPro).length,
      trial: list.filter(s => s.isPro && s.status === 'TRIAL').length,
      paying: paying.length,
      payingPro: paying.filter(s => s.plan === 'PRO').length,
      payingBusiness: paying.filter(s => s.plan === 'BUSINESS').length,
      gifted: list.filter(s => s.isPro && s.source !== 'STRIPE').length,
      mrrCents,
    },
  }
}

const SOLD = ['PAID', 'ACTIVE', 'DONE']

/** Ventes encaissées sur une période : commissions des bookings payés en ligne + services payants */
async function salesBetween(from, to = new Date()) {
  const [commissions, extras] = await Promise.all([
    prisma.bookingPayment.findMany({ where: { paidAt: { gte: from, lte: to } }, select: { paidAt: true, commissionCents: true } }),
    prisma.extraOrder.findMany({ where: { paidAt: { gte: from, lte: to }, status: { in: SOLD } }, select: { paidAt: true, amountCents: true, refundedCents: true } }),
  ])
  return {
    commissions: commissions.map(c => ({ at: c.paidAt, cents: c.commissionCents || 0 })),
    services: extras.map(e => ({ at: e.paidAt, cents: (e.amountCents || 0) - (e.refundedCents || 0) })),
  }
}

const dayKey = (d) => {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

/** Accueil de l'admin : chiffres clés + 30 derniers jours (inscriptions, connexions, ventes) */
async function overviewNumbers(now = new Date()) {
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const weekAgo = new Date(now.getTime() - 7 * 86400000)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const seriesStart = new Date(todayStart.getTime() - 29 * 86400000)
  const members = { role: { not: 'ADMIN' } }

  const [total, artists, organizers, providers, newThisWeek, onlineNow, loginsToday, signups, logins, subs, sales] = await Promise.all([
    prisma.user.count({ where: members }),
    prisma.user.count({ where: { role: 'ARTIST' } }),
    prisma.user.count({ where: { role: 'ORGANIZER' } }),
    prisma.user.count({ where: { role: 'PROVIDER' } }),
    prisma.user.count({ where: { ...members, createdAt: { gte: weekAgo } } }),
    prisma.user.count({ where: { ...members, lastActiveAt: { gte: new Date(now.getTime() - 2 * 60 * 1000) } } }),
    prisma.loginEvent.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.user.findMany({ where: { ...members, createdAt: { gte: seriesStart } }, select: { createdAt: true } }),
    prisma.loginEvent.findMany({ where: { createdAt: { gte: seriesStart } }, select: { createdAt: true } }),
    subscriptionOverview(),
    salesBetween(seriesStart < monthStart ? seriesStart : monthStart, now),
  ])

  const series = []
  const index = new Map()
  for (let i = 0; i < 30; i++) {
    const d = new Date(seriesStart.getTime() + i * 86400000)
    const point = { date: dayKey(d), signups: 0, logins: 0, salesCents: 0 }
    index.set(point.date, point)
    series.push(point)
  }
  signups.forEach(u => { const p = index.get(dayKey(u.createdAt)); if (p) p.signups++ })
  logins.forEach(l => { const p = index.get(dayKey(l.createdAt)); if (p) p.logins++ })
  ;[...sales.commissions, ...sales.services].forEach(s => { const p = index.get(dayKey(s.at)); if (p) p.salesCents += s.cents })

  const inMonth = (s) => new Date(s.at) >= monthStart
  const commissionsCents = sales.commissions.filter(inMonth).reduce((n, s) => n + s.cents, 0)
  const servicesCents = sales.services.filter(inMonth).reduce((n, s) => n + s.cents, 0)

  return {
    members: { total, artists, organizers, providers, newThisWeek, onlineNow, loginsToday },
    subscriptions: subs.totals,
    salesMonth: { commissionsCents, servicesCents, totalCents: commissionsCents + servicesCents },
    series,
  }
}

module.exports = { subscriptionOverview, salesBetween, overviewNumbers, userName, USER_SELECT }
