// services/prestations.js — Prestations et événements d'un profil, pour Mon espace
// (chiffres du tableau de bord, revenus / dépenses, équipe habituelle).
//
// Côté artiste / prestataire : une prestation = un booking accepté qui le cible,
// ou une place confirmée (staff BOOKED) sur l'événement d'un organisateur.
// Un booking accepté crée aussi une place staff : on ne compte qu'une fois par événement.
//
// Côté organisateur : un événement = ses propres événements non annulés, avec ce qu'ils
// ont coûté (cachets du personnel confirmé + dépenses + achats).

const prisma = require('../prisma/client')
const { PERSON_SELECT, publicName } = require('./publicPerson')

const person = (profile) => profile ? {
  profileId: profile.id,
  userId: profile.user?.id ?? null,
  role: profile.user?.role ?? null,
  name: publicName(profile),
  avatar: profile.avatar || null,
} : null

const dateRange = (from, to) => ({ ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) })

/** Prestations d'un artiste / prestataire entre deux dates (bornes facultatives). */
async function artistPrestations(profileId, { from, to } = {}) {
  const now = new Date()
  const range = dateRange(from, to)
  const [bookings, staffs] = await Promise.all([
    prisma.bookingRequest.findMany({
      where: { targetId: profileId, status: { in: ['ACCEPTED', 'COMPLETED'] }, startDate: range },
      include: {
        requester: { select: PERSON_SELECT },
        event: { select: { id: true, title: true, lieu: true, status: true } },
      },
    }),
    prisma.eventStaff.findMany({
      where: { profileId, status: 'BOOKED', event: { status: { not: 'CANCELLED' }, start: range } },
      include: { event: { select: { id: true, title: true, lieu: true, start: true, profile: { select: PERSON_SELECT } } } },
    }),
  ])

  const items = []
  const eventsSeen = new Set()
  for (const b of bookings) {
    if (b.event?.status === 'CANCELLED') continue
    if (b.eventId) eventsSeen.add(b.eventId)
    items.push({
      key: `b${b.id}`,
      bookingId: b.id,
      eventId: b.eventId ?? null,
      date: b.startDate,
      title: b.event?.title || 'Booking',
      city: b.event?.lieu || null,
      counterpart: person(b.requester),
      amount: b.fee ?? 0,
      done: b.startDate < now,
    })
  }
  for (const s of staffs) {
    if (eventsSeen.has(s.eventId)) {
      // Montant manquant sur le booking : on reprend le cachet du poste
      const fromBooking = items.find(i => i.eventId === s.eventId)
      if (fromBooking && !fromBooking.amount && s.fee) fromBooking.amount = s.fee
      continue
    }
    eventsSeen.add(s.eventId)
    items.push({
      key: `s${s.id}`,
      bookingId: null,
      eventId: s.eventId,
      date: s.event.start,
      title: s.event.title,
      city: s.event.lieu || null,
      counterpart: person(s.event.profile),
      amount: s.fee ?? 0,
      done: s.event.start < now,
    })
  }
  return items.sort((a, b) => a.date - b.date)
}

/** Événements d'un organisateur entre deux dates, avec leur coût. */
async function organizerEvents(profileId, { from, to } = {}) {
  const now = new Date()
  const events = await prisma.event.findMany({
    where: { profileId, status: { not: 'CANCELLED' }, start: dateRange(from, to) },
    include: {
      staff: { where: { status: 'BOOKED' }, include: { profile: { select: PERSON_SELECT } } },
      expenses: { select: { amount: true } },
      purchases: { select: { price: true, quantity: true } },
    },
    orderBy: { start: 'asc' },
  })
  return events.map(e => {
    const staffCost = e.staff.reduce((sum, s) => sum + (s.fee || 0), 0)
    const expenses = e.expenses.reduce((sum, x) => sum + (x.amount || 0), 0)
    const purchases = e.purchases.reduce((sum, p) => sum + (p.price || 0) * (p.quantity || 1), 0)
    return {
      key: `e${e.id}`,
      eventId: e.id,
      date: e.start,
      title: e.title,
      city: e.lieu || null,
      staff: e.staff.filter(s => s.profile).map(s => ({ ...person(s.profile), fee: s.fee ?? 0, role: s.role })),
      staffCost,
      expenses,
      purchases,
      amount: staffCost + expenses + purchases,
      budget: e.budget ?? null,
      done: e.start < now,
    }
  })
}

/** Personnes avec qui un organisateur a déjà travaillé (« Mon équipe habituelle »). */
async function organizerTeam(profileId, limit = 8) {
  const [staffs, bookings] = await Promise.all([
    prisma.eventStaff.findMany({
      where: { status: 'BOOKED', profileId: { not: null }, event: { profileId, status: { not: 'CANCELLED' } } },
      include: { profile: { select: { ...PERSON_SELECT, specialties: true, location: true } }, event: { select: { id: true, start: true } } },
    }),
    prisma.bookingRequest.findMany({
      where: { requesterId: profileId, status: { in: ['ACCEPTED', 'COMPLETED'] } },
      include: { target: { select: { ...PERSON_SELECT, specialties: true, location: true } } },
    }),
  ])
  const team = new Map()
  const add = (profile, eventKey, date, role) => {
    if (!profile || profile.id === profileId) return
    const entry = team.get(profile.id) || { ...person(profile), specialties: profile.specialties || [], location: profile.location || null, roles: new Set(), events: new Set(), lastDate: null }
    entry.events.add(eventKey)
    if (role) entry.roles.add(role)
    if (!entry.lastDate || date > entry.lastDate) entry.lastDate = date
    team.set(profile.id, entry)
  }
  for (const s of staffs) add(s.profile, `e${s.event.id}`, s.event.start, s.role)
  for (const b of bookings) add(b.target, b.eventId ? `e${b.eventId}` : `b${b.id}`, b.startDate, null)
  return [...team.values()]
    .map(({ roles, events, ...entry }) => ({ ...entry, collaborations: events.size, specialty: entry.specialties[0] || [...roles][0] || null }))
    .sort((a, b) => b.collaborations - a.collaborations || b.lastDate - a.lastDate)
    .slice(0, limit)
}

module.exports = { artistPrestations, organizerEvents, organizerTeam, person }
