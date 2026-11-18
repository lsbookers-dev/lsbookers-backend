// Versements aux artistes 24 h après la prestation (audit du 18/11/2026) :
// tous les paiements dus sont traités, même au-delà de 100, et les bookings payés à l'avance
// ne bloquent plus la file.
const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const stripeLib = require('../lib/stripe')

const transfers = []
const fakeStripe = {
  transfers: { create: async (params) => { transfers.push(params); return { id: `tr_${transfers.length}` } } },
}
stripeLib.getStripe = () => fakeStripe // avant de charger le service, qui lit getStripe au chargement

const { releaseDuePayouts } = require('../services/bookingPayments')

const NOW = new Date('2027-03-20T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function payment(id, startDate) {
  return {
    id, status: 'PAID', amountCents: 10000, commissionCents: 1000, transferredCents: 0, transferId: null, stripeChargeId: null,
    booking: {
      id, status: 'ACCEPTED', startDate, endDate: null, eventId: null,
      requester: { userId: 1, user: {} },
      target: { userId: 2, user: { stripeAccountId: 'acct_x' } },
    },
  }
}

async function withMocks(mocks, fn) {
  const originals = []
  for (const [model, methods] of Object.entries(mocks)) {
    for (const [name, impl] of Object.entries(methods)) {
      originals.push([model, name, prisma[model][name]])
      prisma[model][name] = impl
    }
  }
  try { return await fn() } finally {
    for (const [model, name, original] of originals) prisma[model][name] = original
  }
}

test('versements : la base ne renvoie que les paiements qui peuvent être dus, et tous sont lus par paquets', async () => {
  transfers.length = 0
  // 250 paiements dont la prestation est passée depuis 3 jours
  const all = Array.from({ length: 250 }, (_, i) => payment(i + 1, new Date(NOW.getTime() - 3 * DAY)))
  const queries = []
  await withMocks({
    adminSettings: { findUnique: async () => null },
    notification: { create: async () => ({}) },
    user: { findUnique: async () => ({ notifPrefs: {} }) },
    pendingEmail: { create: async () => ({}) },
    bookingPayment: {
      findMany: async (args) => {
        queries.push(args)
        const start = args.cursor ? all.findIndex(p => p.id === args.cursor.id) + 1 : 0
        return all.slice(start, start + args.take)
      },
      update: async ({ where }) => ({ id: where.id }),
    },
  }, async () => {
    const released = await releaseDuePayouts(NOW)
    assert.equal(released, 250)
  })
  assert.equal(transfers.length, 250)
  assert.equal(queries.length, 3) // 100 + 100 + 50
  const where = queries[0].where
  assert.equal(where.status, 'PAID')
  assert.deepEqual(where.booking.status, { in: ['ACCEPTED', 'COMPLETED'] })
  // Seules les prestations commencées depuis au moins le délai de versement (24 h par défaut)
  assert.ok(where.booking.startDate.lte <= new Date(NOW.getTime() - DAY))
  assert.equal(transfers[0].amount, 9000) // 100 € moins 10 € de commission
})

test('versements : une prestation sur plusieurs jours pas encore terminée attend', async () => {
  transfers.length = 0
  const p = payment(1, new Date(NOW.getTime() - 2 * DAY))
  p.booking.endDate = new Date(NOW.getTime() + DAY) // se termine demain
  await withMocks({
    adminSettings: { findUnique: async () => null },
    bookingPayment: { findMany: async () => [p], update: async () => { throw new Error('ne doit pas être versé') } },
  }, async () => {
    assert.equal(await releaseDuePayouts(NOW), 0)
  })
  assert.equal(transfers.length, 0)
})
