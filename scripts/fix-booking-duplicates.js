// scripts/fix-booking-duplicates.js — Répare les bookings acceptés avant le 07/10/2026
//
// Avant, accepter un booking créait DEUX événements : celui de l'organisateur (avec la
// personne bookée dans le personnel) + un doublon « Booking — <organisateur> » dans
// l'agenda de la personne bookée. Ce script :
//   1. rattache chaque booking accepté à l'événement de l'organisateur (personnel BOOKED) ;
//   2. supprime les doublons vides de la personne bookée (aucun document, note, dépense…).
//
// Simulation par défaut (ne modifie rien) :  node scripts/fix-booking-duplicates.js
// Application réelle :                        node scripts/fix-booking-duplicates.js --apply

const prisma = require('../prisma/client');
const { attachBookingToOrganizerEvent } = require('../routes/event-bookings');

const APPLY = process.argv.includes('--apply');

function nameOf(user) {
  return user?.pseudo || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Artiste';
}

async function main() {
  console.log(APPLY ? '⚙️  Application réelle' : '🔎 Simulation (rien n’est modifié)');

  const bookings = await prisma.bookingRequest.findMany({
    where: { status: 'ACCEPTED' },
    include: {
      requester: { select: { id: true, user: { select: { pseudo: true, firstName: true, lastName: true } } } },
      target:    { select: { id: true, user: { select: { pseudo: true, firstName: true, lastName: true, role: true } } } },
    },
  });

  for (const br of bookings) {
    const dayStart = new Date(br.startDate); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

    // 1. Rattachement à l'événement de l'organisateur
    const orgEvent = br.eventId
      ? await prisma.event.findFirst({ where: { id: br.eventId, profileId: br.requesterId } })
      : null;
    const staff = orgEvent
      ? await prisma.eventStaff.findFirst({ where: { eventId: orgEvent.id, profileId: br.targetId, status: 'BOOKED' } })
      : null;
    if (!orgEvent || !staff) {
      console.log(`Booking #${br.id} : rattachement à l’événement de l’organisateur${orgEvent ? ` #${orgEvent.id}` : ' (trouvé ou créé)'}`);
      if (APPLY) {
        const eventId = await attachBookingToOrganizerEvent(br, nameOf(br.target.user));
        if (eventId !== br.eventId) await prisma.bookingRequest.update({ where: { id: br.id }, data: { eventId } });
      }
    }

    // 2. Doublons vides dans l'agenda de la personne bookée
    const duplicates = await prisma.event.findMany({
      where: {
        profileId: br.targetId,
        start: { gte: dayStart, lte: dayEnd },
        title: { startsWith: 'Booking — ' },
        description: null,
        notes: null,
        documents: { none: {} },
        staff: { none: {} },
        expenses: { none: {} },
        purchases: { none: {} },
        offers: { none: {} },
        bookingRequests: { none: {} },
        contracts: { none: {} },
        reviews: { none: {} },
      },
      select: { id: true, title: true },
    });
    for (const dup of duplicates) {
      console.log(`Booking #${br.id} : suppression du doublon vide #${dup.id} « ${dup.title} »`);
      if (APPLY) await prisma.event.delete({ where: { id: dup.id } });
    }
  }

  console.log('Terminé.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
