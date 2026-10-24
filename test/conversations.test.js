const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const messageRouter = require('../routes/message')

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
    const target = model === '$' ? prisma : prisma[model]
    for (const [name, impl] of Object.entries(methods)) {
      originals.push([target, name, target[name]])
      target[name] = impl
    }
  }
  try { return await fn() } finally {
    for (const [target, name, original] of originals) target[name] = original
  }
}

const ME = 1
const person = id => ({ id, pseudo: `membre${id}`, role: 'ARTIST', profile: { id: id * 10, avatar: null } })
const participation = convId => ({
  conversationId: convId,
  muted: false,
  conversation: {
    id: convId,
    updatedAt: new Date(2026, 9, 1, 0, convId),
    participants: [{ user: person(ME) }, { user: person(100 + convId) }],
  },
})

async function listConversations(query, { rows, extra = null }) {
  const calls = { findMany: [], findFirst: [], raw: 0 }
  const res = responseRecorder()
  await withMocks({
    user: { update: async () => ({}) },
    conversationParticipant: {
      findMany: async args => { calls.findMany.push(args); return rows.slice(args.skip, args.skip + args.take) },
      count: async ({ where }) => (where.conversation.messages.some.seen === false ? 2 : rows.length),
      findFirst: async args => { calls.findFirst.push(args); return extra },
    },
    $: {
      $queryRaw: async () => {
        calls.raw++
        return rows.map(r => ({ id: r.conversationId * 1000, conversationId: r.conversationId, senderId: 100 + r.conversationId, content: `Salut ${r.conversationId}`, type: 'TEXT', attachmentType: null, seen: false, createdAt: new Date() }))
      },
    },
  }, () => routeHandler(messageRouter, 'get', '/conversations')({ user: { id: ME }, query }, res))
  return { res, calls }
}

test('conversations : paquet de 30, la plus récente d\'abord, avec les totaux', async () => {
  const rows = Array.from({ length: 45 }, (_, i) => participation(45 - i))
  const { res, calls } = await listConversations({}, { rows })
  assert.equal(res.body.conversations.length, 30)
  assert.equal(res.body.total, 45)
  assert.equal(res.body.unreadTotal, 2)
  assert.equal(res.body.hasMore, true)
  assert.equal(res.body.nextCursor, 30)
  assert.equal(calls.findMany[0].take, 31)
  assert.deepEqual(calls.findMany[0].orderBy[0], { conversation: { updatedAt: 'desc' } })
  // Le dernier message de toutes les conversations du paquet vient d'une seule requête
  assert.equal(calls.raw, 1)
  assert.equal(res.body.conversations[0].lastMessage, 'Salut 45')

  const next = await listConversations({ cursor: '30' }, { rows })
  assert.equal(next.res.body.conversations.length, 15)
  assert.equal(next.res.body.hasMore, false)
  assert.equal(next.res.body.nextCursor, null)
})

test('conversations : la conversation ouverte est jointe si elle est plus loin dans la liste', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => participation(40 - i))
  const { res, calls } = await listConversations({ with: '3' }, { rows, extra: participation(3) })
  assert.equal(calls.findFirst[0].where.conversationId, 3)
  assert.equal(calls.findFirst[0].where.userId, ME)
  assert.equal(res.body.conversations.length, 31)
  assert.equal(res.body.conversations.at(-1).id, 3)

  // Déjà dans le paquet : pas de requête en plus
  const inPage = await listConversations({ with: '40' }, { rows })
  assert.equal(inPage.calls.findFirst.length, 0)
})
