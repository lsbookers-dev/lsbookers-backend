// routes/space.js — Mon espace : tableau de bord, finances (revenus / dépenses)
const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { requirePro } = require('../lib/plan')
const { PERSON_SELECT, publicName } = require('../services/publicPerson')
const { activeOfferWhere } = require('../services/offerCleanup')
const { artistPrestations, organizerEvents, organizerTeam, person } = require('../services/prestations')

const monthStart = (date, offset = 0) => new Date(date.getFullYear(), date.getMonth() + offset, 1)
const pct = (current, previous) => (previous ? Math.round(((current - previous) / previous) * 100) : null)

async function myProfile(req) {
  return prisma.profile.findUnique({
    where: { userId: req.user.id },
    select: { id: true, userId: true, user: { select: { role: true } } },
  })
}

/** Vues du profil et nouveaux abonnés du mois (et du mois précédent pour la comparaison). */
async function audience(profile, now) {
  const thisMonth = monthStart(now)
  const lastMonth = monthStart(now, -1)
  const [views, viewsBefore, followers] = await Promise.all([
    prisma.profileView.count({ where: { profileId: profile.id, createdAt: { gte: thisMonth } } }),
    prisma.profileView.count({ where: { profileId: profile.id, createdAt: { gte: lastMonth, lt: thisMonth } } }),
    prisma.follow.count({ where: { followingId: profile.userId, createdAt: { gte: thisMonth } } }),
  ])
  return { views, viewsTrend: pct(views, viewsBefore), newFollowers: followers }
}

/** Bookings à venir (acceptés ou en attente) où je suis demandeur ou cible. */
async function upcomingBookings(profileId, role, now) {
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const bookings = await prisma.bookingRequest.findMany({
    where: {
      status: { in: ['PENDING', 'ACCEPTED'] },
      startDate: { gte: today },
      ...(role === 'ORGANIZER' ? { requesterId: profileId } : { targetId: profileId }),
    },
    include: {
      requester: { select: PERSON_SELECT },
      target: { select: PERSON_SELECT },
      event: { select: { id: true, title: true, lieu: true } },
    },
    orderBy: { startDate: 'asc' },
    take: 8,
  })
  return bookings.map(b => ({
    id: b.id,
    eventId: b.eventId ?? null,
    date: b.startDate,
    status: b.status,
    fee: b.fee ?? null,
    title: b.event?.title || null,
    place: b.event?.lieu || null,
    conversationId: null,
    counterpart: person(role === 'ORGANIZER' ? b.target : b.requester),
  }))
}

/**
 * GET /api/space/dashboard — chiffres de « Mon activité », bookings en cours, équipe habituelle.
 */
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const profile = await myProfile(req)
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })
    const role = profile.user.role === 'ORGANIZER' ? 'ORGANIZER' : 'ARTIST'
    const now = new Date()
    const thisMonth = monthStart(now)

    const [aud, upcoming] = await Promise.all([audience(profile, now), upcomingBookings(profile.id, role, now)])
    const pendingCount = upcoming.filter(b => b.status === 'PENDING').length

    let kpis
    let team = []
    if (role === 'ORGANIZER') {
      const [events, offers] = await Promise.all([
        organizerEvents(profile.id, { to: now }),
        prisma.offer.findMany({ where: { organizerId: profile.id, status: 'ACTIVE' }, select: { id: true, _count: { select: { applications: true } } } }),
      ])
      team = await organizerTeam(profile.id)
      kpis = {
        done: events.length,
        doneThisMonth: events.filter(e => e.date >= thisMonth).length,
        upcoming: upcoming.length,
        upcomingPending: pendingCount,
        applications: offers.reduce((sum, o) => sum + o._count.applications, 0),
        openOffers: offers.length,
        ...aud,
      }
    } else {
      const [done, applications, applicationsPending] = await Promise.all([
        artistPrestations(profile.id, { to: now }),
        prisma.application.count({ where: { applicantId: profile.id } }),
        prisma.application.count({ where: { applicantId: profile.id, status: 'PENDING' } }),
      ])
      kpis = {
        done: done.length,
        doneThisMonth: done.filter(p => p.date >= thisMonth).length,
        upcoming: upcoming.length,
        upcomingPending: pendingCount,
        applications,
        applicationsPending,
        ...aud,
      }
    }

    res.set('Cache-Control', 'private, no-store')
    return res.json({ role, kpis, upcoming, team })
  } catch (err) {
    console.error('❌ GET /space/dashboard :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']

function topOf(values) {
  const counts = new Map()
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1)
  let best = null
  for (const [value, count] of counts) if (!best || count > best.count) best = { value, count }
  return best
}

/**
 * GET /api/space/finances?period=year&year=2026  |  ?period=month&year=2026&month=10
 * Artistes / prestataires : revenus (cachets des prestations).
 * Organisateurs : dépenses par événement (cachets + dépenses + achats).
 * Les montants sont ceux saisis dans les bookings et l'agenda (pas de paiement en ligne pour l'instant).
 */
router.get('/finances', requireAuth, requirePro, async (req, res) => {
  try {
    const profile = await myProfile(req)
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })
    const role = profile.user.role === 'ORGANIZER' ? 'ORGANIZER' : 'ARTIST'

    const now = new Date()
    const period = req.query.period === 'month' ? 'month' : 'year'
    const year = Number.parseInt(req.query.year, 10) || now.getFullYear()
    const month = Math.min(12, Math.max(1, Number.parseInt(req.query.month, 10) || now.getMonth() + 1))
    const from = period === 'month' ? new Date(year, month - 1, 1) : new Date(year, 0, 1)
    const to = period === 'month' ? new Date(year, month, 1) : new Date(year + 1, 0, 1)

    const items = role === 'ORGANIZER'
      ? await organizerEvents(profile.id, { from, to })
      : await artistPrestations(profile.id, { from, to })

    const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, total: 0, done: 0, count: 0 }))
    for (const item of items) {
      const m = months[new Date(item.date).getMonth()]
      m.total += item.amount; m.count += 1
      if (item.done) m.done += item.amount
    }

    // Petites statistiques
    const insights = []
    if (items.length) {
      if (role === 'ORGANIZER') {
        const parts = [
          ['Cachets', items.reduce((s, e) => s + e.staffCost, 0)],
          ['Dépenses', items.reduce((s, e) => s + e.expenses, 0)],
          ['Achats', items.reduce((s, e) => s + e.purchases, 0)],
        ]
        const total = parts.reduce((s, [, v]) => s + v, 0)
        const biggest = parts.sort((a, b) => b[1] - a[1])[0]
        if (total > 0) insights.push({ label: 'Poste le plus coûteux', value: `${biggest[0]} · ${Math.round((biggest[1] / total) * 100)} %` })
        const withBudget = items.filter(e => e.budget)
        if (withBudget.length) insights.push({ label: 'Budget respecté', value: `${withBudget.filter(e => e.amount <= e.budget).length} événement${withBudget.length > 1 ? 's' : ''} sur ${withBudget.length}` })
        const artist = topOf(items.flatMap(e => e.staff.map(s => s.name)))
        if (artist) insights.push({ label: 'Personne la plus bookée', value: `${artist.value} · ${artist.count} date${artist.count > 1 ? 's' : ''}` })
      } else {
        const client = topOf(items.map(p => p.counterpart?.name))
        if (client) insights.push({ label: 'Meilleur client', value: `${client.value} · ${client.count} date${client.count > 1 ? 's' : ''}` })
        const day = topOf(items.map(p => WEEKDAYS[new Date(p.date).getDay()]))
        if (day) insights.push({ label: 'Jour le plus demandé', value: `${day.value.charAt(0).toUpperCase()}${day.value.slice(1)} · ${Math.round((day.count / items.length) * 100)} % des dates` })
        const city = topOf(items.map(p => p.city))
        if (city) insights.push({ label: 'Lieu principal', value: `${city.value} · ${city.count} date${city.count > 1 ? 's' : ''}` })
      }
    }

    res.set('Cache-Control', 'private, no-store')
    return res.json({ role, period, year, month, items, months, insights })
  } catch (err) {
    console.error('❌ GET /space/finances :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/**
 * GET /api/space/next-event — la prochaine date (événement à soi ou place confirmée), une seule.
 */
router.get('/next-event', requireAuth, async (req, res) => {
  try {
    const profile = await myProfile(req)
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })
    const now = new Date()
    const event = await prisma.event.findFirst({
      where: {
        start: { gte: now },
        status: { notIn: ['CANCELLED', 'COMPLETED'] },
        OR: [{ profileId: profile.id }, { staff: { some: { profileId: profile.id, status: 'BOOKED' } } }],
      },
      orderBy: { start: 'asc' },
      select: { id: true, title: true, start: true, end: true, lieu: true },
    })
    res.set('Cache-Control', 'private, no-store')
    return res.json({ event })
  } catch (err) {
    console.error('❌ GET /space/next-event :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/**
 * GET /api/space/opportunities — artistes / prestataires : offres en cours qui correspondent
 * au rôle et aux spécialités (les 3 plus récentes + le nombre total), calculées par la base.
 */
router.get('/opportunities', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({
      where: { userId: req.user.id },
      select: { id: true, specialties: true, user: { select: { role: true } } },
    })
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })
    const role = profile.user.role === 'PROVIDER' ? 'PROVIDER' : 'ARTIST'
    const specialties = (profile.specialties || []).slice(0, 20)
    const where = {
      status: 'ACTIVE',
      type: { in: [role, 'ALL'] },
      organizerId: { not: profile.id },
      AND: [
        activeOfferWhere(),
        ...(specialties.length ? [{
          OR: [
            { specialty: null },
            ...specialties.flatMap(s => [
              { specialty: { equals: s, mode: 'insensitive' } },
              { specialty: { contains: s, mode: 'insensitive' } },
            ]),
          ],
        }] : []),
      ],
    }
    const [total, offers] = await Promise.all([
      prisma.offer.count({ where }),
      prisma.offer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true, title: true, type: true, specialty: true, date: true, location: true, fee: true, organizerId: true, organizer: { select: PERSON_SELECT } },
      }),
    ])
    res.set('Cache-Control', 'private, no-store')
    return res.json({
      total,
      offers: offers.map(({ organizer, ...o }) => ({ ...o, organizer: { name: publicName(organizer) } })),
    })
  } catch (err) {
    console.error('❌ GET /space/opportunities :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
