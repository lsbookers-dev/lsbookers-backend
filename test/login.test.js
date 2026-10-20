const test = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcrypt')

process.env.JWT_SECRET = 'test-secret-for-login'

const prisma = require('../prisma/client')
// Aucun vrai e-mail pendant les tests
const emailUtils = require('../utils/email')
emailUtils.sendLoginAlertEmail = async () => {}
const authRouter = require('../routes/auth')
const notificationsRouter = require('../routes/notifications')

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    cookies: [],
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    cookie(name, value, options) { this.cookies.push({ name, value, options }); return this },
  }
}

function routeHandler(router, path, method = 'post') {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method])
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} introuvable`)
  return layer.route.stack.at(-1).handle
}

function verifiedUser(password) {
  return {
    id: 42,
    email: 'alice@example.test',
    password,
    role: 'ARTIST',
    isAdmin: false,
    emailVerified: true,
    requiresPasswordReset: false,
    tokenVersion: 3,
    profile: { id: 7 },
  }
}

async function login(user, password, { knownDevice = false, previousSessions = 0 } = {}) {
  const originals = {
    findUser: prisma.user.findUnique, transaction: prisma.$transaction,
    sessionFind: prisma.userSession.findFirst, sessionCount: prisma.userSession.count, sessionCreate: prisma.userSession.create,
    notifCreate: prisma.notification.create,
  }
  let transactionCalled = false
  const sessionsCreated = []
  const notifs = []
  prisma.user.findUnique = async () => user
  prisma.$transaction = async () => { transactionCalled = true }
  // Sessions simulées : le test n'écrit jamais dans une vraie base
  prisma.userSession.findFirst = async () => (knownDevice ? { id: 1 } : null)
  prisma.userSession.count = async () => previousSessions
  prisma.userSession.create = async ({ data }) => { sessionsCreated.push(data); return { id: 1, ...data } }
  prisma.notification.create = async ({ data }) => { notifs.push(data); return data }
  const res = responseRecorder()
  try {
    await routeHandler(authRouter, '/login')({
      body: { email: 'alice@example.test', password },
      headers: { 'user-agent': 'Safari iPhone' },
      cookies: {},
    }, res)
    // L'alerte de connexion est créée juste après la réponse
    await new Promise(r => setTimeout(r, 20))
  } finally {
    prisma.user.findUnique = originals.findUser
    prisma.$transaction = originals.transaction
    prisma.userSession.findFirst = originals.sessionFind
    prisma.userSession.count = originals.sessionCount
    prisma.userSession.create = originals.sessionCreate
    prisma.notification.create = originals.notifCreate
  }
  return { res, transactionCalled, sessionsCreated, notifs }
}

test('connexion réussie : cookie de session + appareil, une session enregistrée', async () => {
  const password = await bcrypt.hash('Test1234', 4)
  const { res, transactionCalled, sessionsCreated, notifs } = await login(verifiedUser(password), 'Test1234')

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.user.id, 42)
  assert.deepEqual(res.cookies.map(cookie => cookie.name), ['lsb_device', 'token'])
  assert.equal(transactionCalled, false)
  assert.equal(sessionsCreated.length, 1)
  assert.equal(sessionsCreated[0].userId, 42)
  // Première connexion du compte : pas d'alerte
  assert.equal(notifs.length, 0)
})

test('connexion depuis un nouvel appareil : alerte dans la cloche', async () => {
  const password = await bcrypt.hash('Test1234', 4)
  const user = { ...verifiedUser(password), loginAlerts: true }
  const { notifs } = await login(user, 'Test1234', { previousSessions: 2 })
  await new Promise(r => setImmediate(r))
  assert.equal(notifs.length, 1)
  assert.equal(notifs[0].type, 'NEW_DEVICE_LOGIN')
})

test('appareil déjà connu, ou alertes désactivées : pas d’alerte', async () => {
  const password = await bcrypt.hash('Test1234', 4)
  const known = await login({ ...verifiedUser(password), loginAlerts: true }, 'Test1234', { knownDevice: true, previousSessions: 2 })
  const off = await login({ ...verifiedUser(password), loginAlerts: false }, 'Test1234', { previousSessions: 2 })
  await new Promise(r => setImmediate(r))
  assert.equal(known.notifs.length, 0)
  assert.equal(off.notifs.length, 0)
})

test('mauvais mot de passe : refus générique', async () => {
  const password = await bcrypt.hash('Test1234', 4)
  const { res } = await login(verifiedUser(password), 'Mauvais123')

  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.body, { error: 'Identifiants incorrects' })
  assert.equal(res.cookies.length, 0)
})

test('la connexion reste bloquée tant que le mot de passe doit être réinitialisé', async () => {
  const password = await bcrypt.hash('Test1234', 4)
  const { res } = await login({ ...verifiedUser(password), requiresPasswordReset: true }, 'Test1234')

  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.body, { error: 'PASSWORD_RESET_REQUIRED' })
  assert.equal(res.cookies.length, 0)
})

test('les notifications ne renvoient jamais le jeton appareil', async () => {
  const originalFindMany = prisma.notification.findMany
  prisma.notification.findMany = async () => [{
    id: 1,
    type: 'NEW_DEVICE_LOGIN',
    content: 'Nouvelle connexion',
    read: false,
    createdAt: new Date(),
    actor: null,
    message: null,
    offerId: null,
    publicationId: null,
    deviceToken: '11111111-1111-4111-8111-111111111111',
  }]
  const res = responseRecorder()
  try {
    await routeHandler(notificationsRouter, '/', 'get')({ user: { id: 42 } }, res)
  } finally {
    prisma.notification.findMany = originalFindMany
  }
  assert.equal(res.statusCode, 200)
  assert.equal('deviceToken' in res.body.notifications[0], false)
})
