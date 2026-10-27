// services/agencyDashboard.js — Espace agence (maquette E1) et agenda de l'agence (maquette B1).
// Tout est calculé pour les profils que l'agence gère activement ; la messagerie reste
// séparée (choix d'Antho) : on ne donne que le nombre de messages non lus par profil.
const prisma = require('../prisma/client')
const { countUnreadMessages } = require('../lib/unreadCounts')
const { activeOfferWhere } = require('./offerCleanup')
const { PERSON_SELECT, publicName } = require('./publicPerson')

// Une couleur par profil géré (dans l'ordre d'arrivée), la même partout (sélecteur, espace, agenda)
const PALETTE = ['#f0997b', '#5dcaa5', '#85b7eb', '#d4af6a', '#ed93b1', '#97c459', '#afa9ec', '#ef9f27']
const DAY = 24 * 60 * 60 * 1000

/** Profils gérés activement par l'agence, avec leur couleur */
async function managedProfiles(managerUserId) {
  const list = await prisma.profileManager.findMany({
    where: { managerUserId, status: 'ACTIVE' },
    orderBy: { id: 'asc' },
    select: {
      id: true, requireApproval: true, commissionPct: true,
      profile: { select: { ...PERSON_SELECT, location: true, specialties: true } },
    },
  })
  return list.map((m, i) => ({
    managementId: m.id,
    requireApproval: m.requireApproval,
    commissionPct: m.commissionPct,
    color: PALETTE[i % PALETTE.length],
    profileId: m.profile.id,
    userId: m.profile.user.id,
    role: m.profile.user.role,
    name: publicName(m.profile),
    avatar: m.profile.avatar || null,
    location: m.profile.location || null,
    specialties: m.profile.specialties || [],
  }))
}

/** Messages non lus de chaque profil géré (pastille du sélecteur) */
async function unreadByProfile(profiles) {
  const counts = await Promise.all(profiles.map(p => countUnreadMessages(p.userId)))
  return Object.fromEntries(profiles.map((p, i) => [p.profileId, counts[i]]))
}

function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''))
  const now = new Date()
  const y = m ? Number(m[1]) : now.getUTCFullYear()
  const mo = m ? Number(m[2]) - 1 : now.getUTCMonth()
  return { from: new Date(Date.UTC(y, mo, 1)), to: new Date(Date.UTC(y, mo + 1, 1)), label: `${y}-${String(mo + 1).padStart(2, '0')}` }
}

/** Tout ce que montre l'espace agence */
async function agencyDashboard(managerUserId, { month } = {}) {
  const profiles = await managedProfiles(managerUserId)
  const ids = profiles.map(p => p.profileId)
  const byId = Object.fromEntries(profiles.map(p => [p.profileId, p]))
  const now = new Date()
  const { from, to, label } = monthRange(month)

  const soon = { gte: new Date(now.getTime() - DAY / 2), lte: new Date(now.getTime() + 14 * DAY) }
  const [unread, pending, awaiting, upcomingBookings, upcomingEvents, upcomingStaff, monthBookings, invitations] = await Promise.all([
    unreadByProfile(profiles),
    ids.length ? prisma.bookingRequest.groupBy({ by: ['targetId'], where: { targetId: { in: ids }, status: 'PENDING', awaitingArtistSince: null }, _count: { _all: true } }) : [],
    ids.length ? prisma.bookingRequest.findMany({
      where: { targetId: { in: ids }, status: 'PENDING', awaitingArtistSince: { not: null } },
      select: { id: true, targetId: true, startDate: true },
      orderBy: { startDate: 'asc' },
    }) : [],
    ids.length ? prisma.bookingRequest.findMany({
      where: { targetId: { in: ids }, status: 'ACCEPTED', startDate: { gte: new Date(now.getTime() - DAY / 2), lte: new Date(now.getTime() + 14 * DAY) } },
      select: { id: true, targetId: true, eventId: true, startDate: true, event: { select: { title: true, lieu: true } }, requester: { select: PERSON_SELECT } },
      orderBy: { startDate: 'asc' },
      take: 30,
    }) : [],
    ids.length ? prisma.event.findMany({
      where: { profileId: { in: ids }, status: { not: 'CANCELLED' }, start: { gte: new Date(now.getTime() - DAY / 2), lte: new Date(now.getTime() + 14 * DAY) } },
      select: { id: true, profileId: true, title: true, start: true, lieu: true },
      orderBy: { start: 'asc' },
      take: 30,
    }) : [],
    // Événements d'autres organisateurs où le profil est dans l'équipe (booké)
    ids.length ? prisma.eventStaff.findMany({
      where: { profileId: { in: ids }, status: 'BOOKED', event: { status: { not: 'CANCELLED' }, start: soon } },
      select: { profileId: true, eventId: true, event: { select: { title: true, start: true, lieu: true } } },
      take: 30,
    }) : [],
    ids.length ? prisma.bookingRequest.findMany({
      where: { targetId: { in: ids }, status: { in: ['ACCEPTED', 'COMPLETED'] }, startDate: { gte: from, lt: to } },
      select: { targetId: true, fee: true },
    }) : [],
    prisma.profileManager.findMany({
      where: { managerUserId, status: 'PENDING', expiresAt: { gt: now } },
      select: { id: true, origin: true, invitedEmail: true, expiresAt: true, profile: { select: PERSON_SELECT } },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const pendingCount = Object.fromEntries(pending.map(g => [g.targetId, g._count._all]))

  // À traiter : ce qui attend une action, tous profils confondus
  const todo = []
  for (const p of profiles) {
    if (pendingCount[p.profileId]) todo.push({ kind: 'BOOKING_REQUESTS', profileId: p.profileId, count: pendingCount[p.profileId] })
    if (unread[p.profileId]) todo.push({ kind: 'UNREAD_MESSAGES', profileId: p.profileId, count: unread[p.profileId] })
  }
  for (const a of awaiting) todo.push({ kind: 'AWAITING_ARTIST', profileId: a.targetId, date: a.startDate, bookingId: a.id })
  for (const inv of invitations) {
    todo.push({
      kind: 'INVITATION', managementId: inv.id, date: inv.expiresAt,
      // Invitation à une adresse déjà inscrite : on ne révèle pas à qui elle appartient
      name: inv.origin === 'INVITED' && inv.invitedEmail ? inv.invitedEmail : (publicName(inv.profile) || inv.invitedEmail),
    })
  }

  // Prochaines dates (14 jours)
  const upcoming = [
    ...upcomingBookings.map(b => ({ profileId: b.targetId, date: b.startDate, title: b.event?.title || publicName(b.requester), place: b.event?.lieu || null })),
    ...upcomingEvents.map(e => ({ profileId: e.profileId, date: e.start, title: e.title, place: e.lieu || null })),
    ...upcomingStaff
      .filter(st => !upcomingBookings.some(b => b.targetId === st.profileId && b.eventId === st.eventId))
      .map(st => ({ profileId: st.profileId, date: st.event.start, title: st.event.title, place: st.event.lieu || null })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 12)

  // Prochaine date et bookings du mois, par profil
  const nextDate = {}
  for (const u of upcoming) if (!nextDate[u.profileId]) nextDate[u.profileId] = u.date
  const statement = Object.fromEntries(profiles.map(p => [p.profileId, { bookings: 0, totalFee: 0 }]))
  for (const b of monthBookings) {
    statement[b.targetId].bookings += 1
    statement[b.targetId].totalFee += Number(b.fee) || 0
  }

  // Relevé des cachets (indicatif : l'artiste paie lui-même son agence)
  const statementRows = profiles.map(p => {
    const s = statement[p.profileId]
    const owed = p.commissionPct != null ? Math.round(s.totalFee * p.commissionPct) / 100 : null
    return { profileId: p.profileId, bookings: s.bookings, totalFee: Math.round(s.totalFee * 100) / 100, commissionPct: p.commissionPct, owed }
  })

  return {
    month: label,
    profiles: profiles.map(p => ({
      ...p,
      unread: unread[p.profileId] || 0,
      pendingRequests: pendingCount[p.profileId] || 0,
      bookingsThisMonth: statement[p.profileId].bookings,
      nextDate: nextDate[p.profileId] || null,
    })),
    todo,
    upcoming,
    statement: statementRows,
    opportunities: await opportunitiesFor(profiles),
  }
}

/** Offres ouvertes qui correspondent à un artiste / prestataire géré (3 au plus par profil, 6 en tout) */
async function opportunitiesFor(profiles) {
  const eligible = profiles.filter(p => p.role === 'ARTIST' || p.role === 'PROVIDER').slice(0, 10)
  const found = await Promise.all(eligible.map(async p => {
    const specialties = (p.specialties || []).slice(0, 20)
    const offers = await prisma.offer.findMany({
      where: {
        status: 'ACTIVE',
        type: { in: [p.role, 'ALL'] },
        organizerId: { not: p.profileId },
        applications: { none: { applicantId: p.profileId } },
        AND: [
          activeOfferWhere(),
          ...(specialties.length ? [{ OR: specialties.map(s => ({ specialty: { contains: s, mode: 'insensitive' } })) }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, title: true, date: true, location: true, fee: true, organizer: { select: PERSON_SELECT } },
    })
    return offers.map(({ organizer, ...o }) => ({ ...o, organizer: publicName(organizer), profileId: p.profileId }))
  }))
  return found.flat().sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0)).slice(0, 6)
}

/** Dates de tous les profils gérés (62 jours au plus), affichées dans l'agenda de la personne qui gère : un seul agenda (choix d'Antho) ; eventId = lien vers le détail */
async function agencyAgenda(managerUserId, { from, to }) {
  const start = new Date(from)
  const end = new Date(to)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || end - start > 62 * DAY) {
    const err = new Error('Période invalide')
    err.status = 400
    throw err
  }
  const profiles = await managedProfiles(managerUserId)
  const ids = profiles.map(p => p.profileId)
  if (!ids.length) return { profiles: [], items: [] }
  // Les mêmes sources que l'agenda de chaque profil : ses événements, les événements où il est
  // booké (équipe), ses demandes de booking, et les jours qu'il a marqués (indisponible, booké, option)
  const [bookings, events, staff, marks] = await Promise.all([
    prisma.bookingRequest.findMany({
      where: { targetId: { in: ids }, status: { in: ['PENDING', 'ACCEPTED', 'COMPLETED'] }, startDate: { gte: start, lt: end } },
      select: { id: true, targetId: true, eventId: true, startDate: true, status: true, awaitingArtistSince: true, event: { select: { title: true, lieu: true } }, requester: { select: PERSON_SELECT } },
    }),
    prisma.event.findMany({
      where: { profileId: { in: ids }, status: { not: 'CANCELLED' }, start: { gte: start, lt: end } },
      select: { id: true, profileId: true, title: true, start: true, lieu: true },
    }),
    prisma.eventStaff.findMany({
      where: { profileId: { in: ids }, status: { in: ['BOOKED', 'PENDING'] }, event: { status: { not: 'CANCELLED' }, start: { gte: start, lt: end } } },
      select: { id: true, profileId: true, eventId: true, status: true, event: { select: { title: true, start: true, lieu: true } } },
    }),
    prisma.availability.findMany({
      where: { profileId: { in: ids }, status: { in: ['UNAVAILABLE', 'BOOKED', 'TENTATIVE'] }, date: { gte: start, lt: end } },
      select: { id: true, profileId: true, date: true, status: true },
    }),
  ])
  const bookedEvents = new Set(bookings.filter(b => b.eventId).map(b => `${b.targetId}:${b.eventId}`))
  const items = [
    ...bookings.map(b => ({
      id: `b${b.id}`, profileId: b.targetId, date: b.startDate, eventId: b.eventId || null,
      title: b.event?.title || publicName(b.requester), place: b.event?.lieu || null,
      // option = demande pas encore acceptée (ou en attente de l'accord de l'artiste)
      status: b.status === 'PENDING' ? 'OPTION' : 'CONFIRMED',
      awaitingArtist: !!b.awaitingArtistSince,
    })),
    ...events.map(e => ({ id: `e${e.id}`, profileId: e.profileId, date: e.start, eventId: e.id, title: e.title, place: e.lieu || null, status: 'CONFIRMED', awaitingArtist: false })),
    // Équipe d'un événement (sans doublon avec le booking qui l'a créée)
    ...staff.filter(s => !bookedEvents.has(`${s.profileId}:${s.eventId}`)).map(s => ({
      id: `s${s.id}`, profileId: s.profileId, date: s.event.start, eventId: s.eventId, title: s.event.title, place: s.event.lieu || null,
      status: s.status === 'BOOKED' ? 'CONFIRMED' : 'OPTION', awaitingArtist: false,
    })),
  ]
  // Jours marqués à la main dans l'agenda, s'il n'y a rien d'autre ce jour-là pour ce profil
  const dayKey = (profileId, d) => `${profileId}:${new Date(d).toISOString().slice(0, 10)}`
  const busy = new Set(items.map(i => dayKey(i.profileId, i.date)))
  const MARK = { UNAVAILABLE: ['Indisponible', 'CONFIRMED'], BOOKED: ['Booké', 'CONFIRMED'], TENTATIVE: ['Option', 'OPTION'] }
  for (const m of marks) {
    if (busy.has(dayKey(m.profileId, m.date))) continue
    const [title, status] = MARK[m.status]
    items.push({ id: `a${m.id}`, profileId: m.profileId, date: m.date, eventId: null, title, place: null, status, awaitingArtist: false })
  }
  items.sort((a, b) => new Date(a.date) - new Date(b.date))
  return {
    profiles: profiles.map(p => ({ profileId: p.profileId, name: p.name, color: p.color, avatar: p.avatar, role: p.role })),
    items,
  }
}

/**
 * Profil public : « Géré par … » (agence qui a la formule) et, pour une agence,
 * la rubrique de ses profils (« Artistes représentés », « Nos lieux » ou « Nos profils »).
 */
async function publicAgencyLinks(profileId, userId) {
  const { agencyManagerWhere, hasAgency } = require('../lib/plan')
  const visible = { pausedAt: null, bannedAt: null, emailVerified: true }
  const [managedBy, isAgency] = await Promise.all([
    prisma.profileManager.findFirst({
      where: { profileId, status: 'ACTIVE', manager: { ...agencyManagerWhere(), ...visible } },
      select: { manager: { select: { id: true, role: true, profile: { select: PERSON_SELECT } } } },
    }),
    hasAgency(userId),
  ])
  const represented = isAgency
    ? await prisma.profileManager.findMany({
        where: { managerUserId: userId, status: 'ACTIVE', profile: { user: visible, hiddenFromSearch: false } },
        orderBy: { id: 'asc' },
        select: { profile: { select: { ...PERSON_SELECT, specialties: true, typeEtablissement: true, location: true } } },
        take: 60,
      })
    : []
  const list = represented.map(m => ({
    profileId: m.profile.id,
    userId: m.profile.user.id,
    role: m.profile.user.role,
    name: publicName(m.profile),
    avatar: m.profile.avatar || null,
    specialty: m.profile.user.role === 'ORGANIZER' ? (m.profile.typeEtablissement || m.profile.specialties?.[0] || null) : (m.profile.specialties?.[0] || null),
    location: m.profile.location || null,
  }))
  const allArtists = list.length > 0 && list.every(p => p.role === 'ARTIST')
  const allVenues = list.length > 0 && list.every(p => p.role === 'ORGANIZER')
  return {
    managedBy: managedBy?.manager?.profile
      ? { userId: managedBy.manager.id, role: managedBy.manager.role, name: publicName(managedBy.manager.profile), avatar: managedBy.manager.profile.avatar || null }
      : null,
    represents: list.length ? { title: allArtists ? 'Artistes représentés' : allVenues ? 'Nos lieux' : 'Nos profils', profiles: list } : null,
  }
}

module.exports = { PALETTE, managedProfiles, unreadByProfile, agencyDashboard, agencyAgenda, monthRange, publicAgencyLinks }
