process.env.LSB_DISABLE_EMAILS = '1'

const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const notificationsRouter = require('../routes/notifications')
const { createNotif } = require('../services/notifications')
const { categoryOf } = require('../lib/notifPrefs')

function responseRecorder() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this }, json(b) { this.body = b; return this } }
}

function routeHandler(router, method, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method])
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} introuvable`)
  return layer.route.stack.at(-1).handle
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

test('J’aime défait puis refait : une seule notification', async () => {
  let created = 0
  const mocks = (alreadyThere) => ({
    user: { findUnique: async () => ({ email: null, notifPrefs: null }) },
    notification: { findFirst: async () => (alreadyThere ? { id: 1 } : null), create: async () => { created++ } },
  })
  await withMocks(mocks(false), () => createNotif({ userId: 2, type: 'NEW_LIKE', content: 'x', actorId: 3, publicationId: 9 }))
  await withMocks(mocks(true), () => createNotif({ userId: 2, type: 'NEW_LIKE', content: 'x', actorId: 3, publicationId: 9 }))
  assert.equal(created, 1)
})

test('un commentaire n’est jamais fusionné : chaque commentaire prévient', async () => {
  let looked = false
  let created = 0
  await withMocks({
    user: { findUnique: async () => ({ email: null, notifPrefs: null }) },
    notification: { findFirst: async () => { looked = true; return { id: 1 } }, create: async () => { created++ } },
  }, () => createNotif({ userId: 2, type: 'NEW_COMMENT', content: 'x', actorId: 3, publicationId: 9 }))
  assert.equal(looked, false)
  assert.equal(created, 1)
})

test('« lu » seulement pour les notifications affichées, et seulement les siennes', async () => {
  let where
  const res = responseRecorder()
  await withMocks({
    notification: { updateMany: async (a) => { where = a.where; return { count: 2 } } },
  }, () => routeHandler(notificationsRouter, 'patch', '/mark-read')({ user: { id: 5 }, body: { ids: [3, '4', 4, -1, 'x'] } }, res))
  assert.deepEqual(where, { userId: 5, id: { in: [3, 4] }, read: false })
  assert.equal(res.body.count, 2)
})

test('notifications Business et abonnement : réglables dans les Réglages', () => {
  assert.equal(categoryOf('MANAGEMENT_INVITE'), 'business')
  assert.equal(categoryOf('EXTRA_ORDER_UPDATE'), 'account')
  assert.equal(categoryOf('BOOKING_APPROVAL_NEEDED'), 'bookings')
})
