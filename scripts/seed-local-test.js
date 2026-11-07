// Comptes de test pour la base LOCALE lsb_local (jamais la production).
// Connexion : artiste@test.local, orga@test.local, intermittent@test.local, admin@test.local — mot de passe ci-dessous (TestLocal-…).

const path = '/Users/antho/Desktop/lsbookers/backend/node_modules/'
const { PrismaClient } = require(path + '@prisma/client')
const bcrypt = require(path + 'bcrypt')
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://antho@localhost:5432/lsb_local' } } })
;(async () => {
  const password = await bcrypt.hash('TestLocal-2026!', 10)
  const users = [
    { email: 'artiste@test.local', pseudo: 'DJNovaTest', role: 'ARTIST', firstName: 'Nova', lastName: 'Test', location: 'Marseille', lat: 43.2964, lon: 5.3778, legalStatus: 'AUTO_ENTREPRENEUR' },
    { email: 'orga@test.local', pseudo: 'ClubTest', role: 'ORGANIZER', firstName: 'Orga', lastName: 'Test', location: 'Marseille', lat: 43.2964, lon: 5.3778, legalStatus: 'COMPANY' },
    { email: 'intermittent@test.local', pseudo: 'SaxoTest', role: 'ARTIST', firstName: 'Saxo', lastName: 'Test', location: 'Lyon', lat: 45.7578, lon: 4.832, legalStatus: 'INTERMITTENT' },
    { email: 'admin@test.local', pseudo: 'AdminTest', role: 'ADMIN', firstName: 'Admin', lastName: 'Test', location: 'Paris', lat: 48.8566, lon: 2.3522 },
  ]
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email, password, role: u.role, pseudo: u.pseudo, firstName: u.firstName, lastName: u.lastName,
        emailVerified: true, registrationStep: 5, payoutMode: u.legalStatus === 'INTERMITTENT' ? 'INTERMITTENT' : null,
        profile: { create: { location: u.location, country: 'France', latitude: u.lat, longitude: u.lon, legalStatus: u.legalStatus || null, specialties: u.role === 'ARTIST' ? ['DJ'] : [] } },
      },
    })
  }
  const art = await prisma.user.findUnique({ where: { email: 'artiste@test.local' }, include: { profile: true } })
  const org = await prisma.user.findUnique({ where: { email: 'orga@test.local' }, include: { profile: true } })
  // Un booking accepté dans 90 jours, cachet 500 €
  const start = new Date(Date.now() + 90 * 86400000); start.setUTCHours(0, 0, 0, 0)
  const exists = await prisma.bookingRequest.findFirst({ where: { requesterId: org.profile.id, targetId: art.profile.id } })
  if (!exists) {
    const ev = await prisma.event.create({ data: { title: 'Soirée test', start, status: 'PUBLISHED', profileId: org.profile.id, isPrivate: true } })
    const br = await prisma.bookingRequest.create({ data: { requesterId: org.profile.id, targetId: art.profile.id, startDate: start, fee: 500, status: 'ACCEPTED', eventId: ev.id } })
    await prisma.eventStaff.create({ data: { eventId: ev.id, role: 'ARTIST', status: 'BOOKED', profileId: art.profile.id, fee: 500 } })
    const conv = await prisma.conversation.create({ data: { participants: { create: [{ userId: org.id }, { userId: art.id }] } } })
    await prisma.message.create({ data: { content: 'Proposition de booking', senderId: org.id, conversationId: conv.id, type: 'BOOKING_REQUEST', bookingRequestId: br.id } })
  }
  console.log('seed ok', art.id, org.id)
  await prisma.$disconnect()
})().catch(e => { console.error(e); process.exit(1) })
