const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const notificationsRouter = require('../routes/notifications')

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this },
    set(name, value) { this.headers[name] = value; return this },
    json(body) { this.body = body; return this },
  }
}

function routeHandler(router, method, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method])
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} introuvable`)
  return layer.route.stack.at(-1).handle
}

test('pastilles : messages et notifications non lus en un seul appel', async () => {
  const originals = { message: prisma.message.count, notification: prisma.notification.count }
  const seen = {}
  prisma.message.count = async args => { seen.message = args.where; return 4 }
  prisma.notification.count = async args => { seen.notification = args.where; return 7 }
  try {
    const res = responseRecorder()
    await routeHandler(notificationsRouter, 'get', '/counts')({ user: { id: 5 } }, res)
    assert.deepEqual(res.body, { messages: 4, notifications: 7 })
    assert.equal(res.headers['Cache-Control'], 'no-store')
    // Messages : reçus (pas envoyés), non lus, hors conversations en sourdine
    assert.deepEqual(seen.message, {
      seen: false,
      senderId: { not: 5 },
      conversation: { participants: { some: { userId: 5, muted: false } } },
    })
    // Cloche : jamais les anciennes notifications de message
    assert.deepEqual(seen.notification, { userId: 5, read: false, NOT: { type: 'NEW_MESSAGE' } })
  } finally {
    prisma.message.count = originals.message
    prisma.notification.count = originals.notification
  }
})
