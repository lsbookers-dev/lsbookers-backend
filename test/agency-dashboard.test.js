// Espace agence (E1) et agenda de l'agence (B1) : calculés uniquement sur les profils gérés activement.
process.env.LSB_DISABLE_EMAILS = '1'

const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const { agencyDashboard, agencyAgenda, PALETTE } = require('../services/agencyDashboard')

async function withMocks(mocks, fn) {
  const originals = []
  for (const [model, methods] of Object.entries(mocks)) {
    for (const [name, impl] of Object.entries(methods)) {
      originals.push([model, name, prisma[model][name]])
      prisma[model][name] = impl
    }
  }
  try {
    return await fn()
  } finally {
    for (const [model, name, original] of originals) prisma[model][name] = original
  }
}

const managed = (id, profileId, name, extra = {}) => ({
  id, requireApproval: true, commissionPct: null, ...extra,
  profile: { id: profileId, avatar: null, showRealName: false, location: 'Nice', specialties: ['DJ'], user: { id: profileId + 100, pseudo: name, firstName: null, lastName: null, role: 'ARTIST' } },
})

test('espace agence : à traiter, relevé des cachets au taux convenu, une couleur par profil', async () => {
  const groupBy = []
  await withMocks({
    profileManager: {
      findMany: async ({ where }) => (where.status === 'ACTIVE'
        ? [managed(1, 10, 'Nina', { commissionPct: 12 }), managed(2, 20, 'Kobalt')]
        : [{ id: 9, origin: 'INVITED', invitedEmail: 'x@test.local', expiresAt: new Date(), profile: { user: { pseudo: 'Secret' } } }]),
    },
    message: { count: async ({ where }) => (where.senderId.not === 110 ? 2 : 0) },
    bookingRequest: {
      groupBy: async (args) => { groupBy.push(args); return [{ targetId: 20, _count: { _all: 3 } }] },
      findMany: async ({ where }) => {
        if (where.awaitingArtistSince) return [{ id: 7, targetId: 10, startDate: new Date('2026-11-12') }]
        if (where.status?.in) return [{ targetId: 10, fee: 1000 }, { targetId: 10, fee: 500 }, { targetId: 20, fee: 300 }]
        return []
      },
    },
    event: { findMany: async () => [] },
    eventStaff: { findMany: async () => [] },
    offer: { findMany: async () => [] },
  }, async () => {
    const d = await agencyDashboard(1, { month: '2026-11' })
    assert.equal(d.month, '2026-11')
    assert.deepEqual(d.profiles.map(p => p.color), [PALETTE[0], PALETTE[1]])
    // Seule la base est interrogée pour les profils de l'agence
    assert.deepEqual(groupBy[0].where.targetId, { in: [10, 20] })
    const kinds = d.todo.map(t => `${t.kind}:${t.profileId ?? t.managementId}`)
    assert.ok(kinds.includes('BOOKING_REQUESTS:20'))
    assert.ok(kinds.includes('UNREAD_MESSAGES:10'))
    assert.ok(kinds.includes('AWAITING_ARTIST:10'))
    // Invitation à une adresse déjà inscrite : on n'affiche que l'adresse
    assert.equal(d.todo.find(t => t.kind === 'INVITATION').name, 'x@test.local')
    const nina = d.statement.find(s => s.profileId === 10)
    assert.deepEqual(nina, { profileId: 10, bookings: 2, totalFee: 1500, commissionPct: 12, owed: 180 })
    assert.equal(d.statement.find(s => s.profileId === 20).owed, null)
  })
})

test('agenda de l’agence : période limitée à 62 jours', async () => {
  await assert.rejects(agencyAgenda(1, { from: '2026-01-01', to: '2026-06-01' }), err => err.status === 400)
  await assert.rejects(agencyAgenda(1, { from: 'n’importe quoi', to: '2026-06-01' }), err => err.status === 400)
})

test('agenda de l’agence : options et dates confirmées des profils gérés', async () => {
  await withMocks({
    profileManager: { findMany: async () => [managed(1, 10, 'Nina')] },
    bookingRequest: {
      findMany: async () => [
        { id: 1, targetId: 10, startDate: new Date('2026-11-05'), status: 'PENDING', awaitingArtistSince: new Date(), event: null, requester: { user: { pseudo: 'Le Rex' } } },
        { id: 2, targetId: 10, startDate: new Date('2026-11-01'), status: 'ACCEPTED', awaitingArtistSince: null, event: { title: 'Festival', lieu: 'Nice' }, requester: { user: { pseudo: 'Le Rex' } } },
      ],
    },
    event: { findMany: async () => [] },
    // Équipe d'un événement d'un autre organisateur, et jours marqués à la main dans l'agenda
    eventStaff: { findMany: async () => [{ id: 3, profileId: 10, eventId: 77, status: 'BOOKED', event: { title: 'Gala', start: new Date('2026-11-20'), lieu: 'Cannes' } }] },
    availability: { findMany: async () => [
      { id: 4, profileId: 10, date: new Date('2026-11-25'), status: 'UNAVAILABLE' },
      { id: 5, profileId: 10, date: new Date('2026-11-01'), status: 'UNAVAILABLE' }, // déjà un booking ce jour-là
    ] },
  }, async () => {
    const a = await agencyAgenda(1, { from: '2026-11-01', to: '2026-12-01' })
    assert.deepEqual(a.items.map(i => [i.title, i.status, i.awaitingArtist]), [
      ['Festival', 'CONFIRMED', false], ['Le Rex', 'OPTION', true], ['Gala', 'CONFIRMED', false], ['Indisponible', 'CONFIRMED', false],
    ])
  })
})
