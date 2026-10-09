const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const reviewsRouter = require('../routes/reviews')
const { expiredOfferWhere } = require('../services/offerCleanup')

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    set() { return this },
  }
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

const person = (id, userId, extra = {}) => ({
  id, avatar: null, showRealName: false,
  user: { id: userId, pseudo: `pseudo${id}`, firstName: 'Jean', lastName: 'Secret', role: 'ARTIST' },
  ...extra,
})
const ME = person(1, 10)
const DJ = person(2, 20)
const PAST = new Date(Date.now() - 2 * 24 * 3600 * 1000)

const finishedBooking = {
  id: 5, requesterId: 1, targetId: 2, eventId: null, startDate: PAST, endDate: null,
  requester: ME, target: DJ, event: null,
}

async function postReview(body, bookings) {
  const created = []
  const res = responseRecorder()
  await withMocks({
    profile: { findUnique: async () => ME },
    bookingRequest: { findMany: async () => bookings },
    eventStaff: { findMany: async () => [] },
    review: { create: async ({ data }) => { created.push(data); return { id: 1, ...data } } },
    notification: { create: async () => ({}) },
  }, () => routeHandler(reviewsRouter, 'post', '/')({ user: { id: 10 }, body }, res))
  return { res, created }
}

test('impossible de laisser un avis sans prestation terminée', async () => {
  const { res, created } = await postReview({ bookingId: 5, rating: 1 }, [])
  assert.equal(res.statusCode, 403)
  assert.equal(created.length, 0)
})

test('avis accepté après un booking terminé, cible = la personne en face', async () => {
  const { res, created } = await postReview({ bookingId: 5, rating: 5, comment: 'Top' }, [finishedBooking])
  assert.equal(res.statusCode, 201)
  assert.equal(created[0].targetId, 2)
  assert.equal(created[0].bookingId, 5)
})

test('la liste publique ne montre que les avis vérifiés et respecte le pseudo', async () => {
  let where
  const res = responseRecorder()
  await withMocks({
    review: {
      findMany: async (args) => { where = args.where; return [{ id: 1, rating: 4, comment: null, createdAt: PAST, author: DJ }] },
      aggregate: async () => ({ _avg: { rating: 4 }, _count: { rating: 1 } }),
    },
  }, () => routeHandler(reviewsRouter, 'get', '/profile/:profileId')({ params: { profileId: '1' } }, res))
  assert.ok(where.OR, 'filtre « avis vérifiés » attendu')
  assert.equal(res.body.reviews[0].author.name, 'pseudo2')
  assert.ok(!JSON.stringify(res.body).includes('Secret'), 'le vrai nom ne doit pas fuiter')
  assert.equal(res.body.average, 4)
})

test('une offre est considérée passée 24 h après sa date', () => {
  const now = new Date('2026-10-10T12:00:00Z')
  const cutoff = expiredOfferWhere(now).OR[1].date.lt
  assert.equal(cutoff.toISOString(), '2026-10-09T12:00:00.000Z')
})

test('fin de prestation : chacun reçoit « laissez votre avis » une seule fois', async () => {
  const { sendReviewInvites } = require('../services/reviewInvites')
  const notifs = []
  const marked = []
  await withMocks({
    bookingRequest: {
      findMany: async () => [{ ...finishedBooking, eventId: 9, event: { status: 'PUBLISHED' } }],
      update: async ({ where }) => { marked.push(`b${where.id}`) },
    },
    eventStaff: {
      updateMany: async ({ where }) => { marked.push(`s-event${where.eventId}`) },
      findMany: async () => [],
    },
    notification: { create: async ({ data }) => { notifs.push(data) } },
  }, () => sendReviewInvites(new Date('2026-10-10T12:00:00Z')))
  assert.equal(notifs.length, 2)
  assert.deepEqual(notifs.map(n => n.userId).sort(), [10, 20])
  assert.match(notifs.find(n => n.userId === 10).content, /^Dès maintenant, laissez votre avis à pseudo2 pour la prestation du /)
  assert.ok(notifs.every(n => n.eventId === 9 && n.type === 'REVIEW_AVAILABLE'))
  assert.deepEqual(marked, ['b5', 's-event9'])
})
