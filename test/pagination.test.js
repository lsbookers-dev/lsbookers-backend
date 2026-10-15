const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const publicationsRouter = require('../routes/publications')
const notificationsRouter = require('../routes/notifications')

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
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

const comment = id => ({ id, content: `c${id}`, replies: [], _count: { likes: 0, replies: 0 } })

test('commentaires : un paquet de 20 + curseur quand il en reste', async () => {
  let args
  const res = responseRecorder()
  await withMocks({
    publicationComment: { findMany: async a => { args = a; return Array.from({ length: 21 }, (_, i) => comment(i + 1)) } },
  }, () => routeHandler(publicationsRouter, 'get', '/:id/comments')({ params: { id: '1' }, query: {} }, res))
  assert.equal(args.take, 21)
  assert.equal(args.include.replies.take, 3)
  assert.equal(res.body.comments.length, 20)
  assert.equal(res.body.hasMore, true)
  assert.equal(res.body.nextCursor, 20)
})

test('commentaires : ?after= ne renvoie que les suivants, dernier paquet sans curseur', async () => {
  let args
  const res = responseRecorder()
  await withMocks({
    publicationComment: { findMany: async a => { args = a; return [comment(21), comment(22)] } },
  }, () => routeHandler(publicationsRouter, 'get', '/:id/comments')({ params: { id: '1' }, query: { after: '20' } }, res))
  assert.deepEqual(args.where.id, { gt: 20 })
  assert.equal(res.body.hasMore, false)
  assert.equal(res.body.nextCursor, null)
})

test('réponses : suite paginée des réponses d\'un commentaire', async () => {
  let args
  const res = responseRecorder()
  await withMocks({
    publicationComment: { findMany: async a => { args = a; return [comment(5), comment(6)] } },
  }, () => routeHandler(publicationsRouter, 'get', '/comments/:id/replies')({ params: { id: '4' }, query: { after: '3', limit: '1' } }, res))
  assert.equal(args.where.parentId, 4)
  assert.deepEqual(args.where.id, { gt: 3 })
  assert.equal(res.body.replies.length, 1)
  assert.equal(res.body.nextCursor, 5)
})

const notif = id => ({ id, type: 'NEW_LIKE', content: '', read: false, createdAt: new Date('2026-10-16') })

test('notifications : « Voir plus » repart de la dernière affichée', async () => {
  let args
  const res = responseRecorder()
  await withMocks({
    notification: {
      findFirst: async () => ({ createdAt: new Date('2026-10-16') }),
      findMany: async a => { args = a; return [notif(9), notif(8), notif(7)] },
    },
  }, () => routeHandler(notificationsRouter, 'get', '/')({ user: { id: 1 }, query: { before: '10', limit: '2' } }, res))
  assert.equal(args.take, 3)
  assert.ok(args.where.OR)
  assert.equal(res.body.notifications.length, 2)
  assert.equal(res.body.hasMore, true)
  assert.equal(res.body.nextCursor, 8)
})

test('notifications : curseur d\'un autre compte → liste vide', async () => {
  const res = responseRecorder()
  await withMocks({
    notification: { findFirst: async () => null, findMany: async () => { throw new Error('ne doit pas être appelé') } },
  }, () => routeHandler(notificationsRouter, 'get', '/')({ user: { id: 1 }, query: { before: '99' } }, res))
  assert.deepEqual(res.body, { notifications: [], hasMore: false, nextCursor: null })
})
