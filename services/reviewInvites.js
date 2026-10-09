// services/reviewInvites.js — « Dès maintenant, laissez votre avis… »
// Une fois une prestation terminée (booking accepté ou poste staff confirmé),
// chacune des deux parties reçoit une notification l'invitant à évaluer l'autre.
// Envoyée une seule fois (reviewInviteSentAt), uniquement pour les prestations
// terminées depuis moins de 7 jours (pas de rattrapage massif de l'historique).

const prisma = require('../prisma/client')
const { createNotif } = require('./notifications')
const { PERSON_SELECT, publicName, frenchDate } = require('./publicPerson')

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const endedBetween = (from, to, endField, startField) => ({
  OR: [
    { [endField]: { gte: from, lt: to } },
    { [endField]: null, [startField]: { gte: from, lt: to } },
  ],
})

async function invite(a, b, date, eventId) {
  // a et b : profils (PERSON_SELECT) des deux parties
  for (const [me, other] of [[a, b], [b, a]]) {
    await createNotif({
      userId: me.user?.id,
      type: 'REVIEW_AVAILABLE',
      content: `Dès maintenant, laissez votre avis à ${publicName(other)} pour la prestation du ${frenchDate(date)}`,
      actorId: other.user?.id,
      eventId,
    })
  }
}

async function sendReviewInvites(now = new Date()) {
  const from = new Date(now.getTime() - WINDOW_MS)
  let sent = 0

  const bookings = await prisma.bookingRequest.findMany({
    where: {
      status: { in: ['ACCEPTED', 'COMPLETED'] },
      reviewInviteSentAt: null,
      ...endedBetween(from, now, 'endDate', 'startDate'),
    },
    include: {
      requester: { select: PERSON_SELECT },
      target: { select: PERSON_SELECT },
      event: { select: { status: true } },
    },
  })
  for (const b of bookings) {
    if (b.event?.status !== 'CANCELLED') {
      await invite(b.requester, b.target, b.endDate || b.startDate, b.eventId)
      sent++
    }
    await prisma.bookingRequest.update({ where: { id: b.id }, data: { reviewInviteSentAt: now } })
    // Le booking accepté a aussi créé un poste staff sur l'événement : pas de doublon
    if (b.eventId) {
      await prisma.eventStaff.updateMany({
        where: { eventId: b.eventId, profileId: b.targetId, reviewInviteSentAt: null },
        data: { reviewInviteSentAt: now },
      })
    }
  }

  const staffs = await prisma.eventStaff.findMany({
    where: {
      status: 'BOOKED',
      profileId: { not: null },
      reviewInviteSentAt: null,
      event: { status: { not: 'CANCELLED' }, ...endedBetween(from, now, 'end', 'start') },
    },
    include: {
      profile: { select: PERSON_SELECT },
      event: { select: { id: true, start: true, end: true, profile: { select: PERSON_SELECT } } },
    },
  })
  for (const s of staffs) {
    if (s.profile && s.event.profile && s.profile.id !== s.event.profile.id) {
      await invite(s.event.profile, s.profile, s.event.end || s.event.start, s.event.id)
      sent++
    }
    await prisma.eventStaff.update({ where: { id: s.id }, data: { reviewInviteSentAt: now } })
  }

  if (sent) console.log(`⭐ ${sent} invitation(s) à laisser un avis envoyée(s)`)
  return sent
}

module.exports = { sendReviewInvites }
