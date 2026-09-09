const test = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcrypt')

process.env.JWT_SECRET = 'test-secret-for-device-trust'

const prisma = require('../prisma/client')
const emailModulePath = require.resolve('../utils/email')
const originalEmailModule = require(emailModulePath)
const sentDeviceEmails = []
let deviceEmailFailure = null
require.cache[emailModulePath].exports = {
  ...originalEmailModule,
  sendVerificationEmail: async () => {},
  sendNewDeviceEmail: async (...args) => {
    sentDeviceEmails.push(args)
    if (deviceEmailFailure) throw deviceEmailFailure
  },
}

const authRouter = require('../routes/auth')
const notificationsRouter = require('../routes/notifications')

const DEVICE_TOKEN = '11111111-1111-4111-8111-111111111111'

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

test('un LoginEvent seul ne rend plus un appareil fiable', async () => {
  sentDeviceEmails.length = 0
  deviceEmailFailure = null
  const password = await bcrypt.hash('Test1234', 4)
  const originals = {
    findUser: prisma.user.findUnique,
    transaction: prisma.$transaction,
  }
  const challenges = []
  const notifications = []
  const loginEvents = []

  prisma.user.findUnique = async () => verifiedUser(password)
  prisma.$transaction = async callback => callback({
    $queryRawUnsafe: async () => [{ pg_advisory_xact_lock: null }],
    trustedDevice: { findUnique: async () => null },
    deviceVerification: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      create: async ({ data }) => {
        const row = { ...data, token: 'verification-token' }
        challenges.push(row)
        return row
      },
    },
    notification: { create: async ({ data }) => { notifications.push(data); return data } },
    loginEvent: { create: async ({ data }) => { loginEvents.push(data); return data } },
  })

  const req = {
    body: { email: 'alice@example.test', password: 'Test1234' },
    headers: { 'user-agent': 'Safari iPhone', 'x-device-token': DEVICE_TOKEN },
    cookies: {},
  }
  const res = responseRecorder()

  try {
    await routeHandler(authRouter, '/login')(req, res)
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    prisma.user.findUnique = originals.findUser
    prisma.$transaction = originals.transaction
  }

  assert.equal(res.statusCode, 200)
  assert.equal(challenges.length, 1)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].deviceToken, DEVICE_TOKEN)
  assert.equal(loginEvents.length, 1)
  assert.equal(sentDeviceEmails.length, 1)
})

test('un challenge actif déduplique les alertes du même appareil', async () => {
  sentDeviceEmails.length = 0
  deviceEmailFailure = null
  const password = await bcrypt.hash('Test1234', 4)
  const originals = { findUser: prisma.user.findUnique, transaction: prisma.$transaction }
  let createCalled = false

  prisma.user.findUnique = async () => verifiedUser(password)
  prisma.$transaction = async callback => callback({
    $queryRawUnsafe: async () => [{ pg_advisory_xact_lock: null }],
    trustedDevice: { findUnique: async () => null },
    deviceVerification: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async ({ where }) => where.deviceToken ? { id: 1 } : { id: 1 },
      create: async () => { createCalled = true },
    },
    notification: { create: async () => { throw new Error('notification inattendue') } },
    loginEvent: { create: async () => ({}) },
  })

  const req = {
    body: { email: 'alice@example.test', password: 'Test1234' },
    headers: { 'user-agent': 'Safari iPhone', 'x-device-token': DEVICE_TOKEN },
    cookies: {},
  }
  const res = responseRecorder()

  try {
    await routeHandler(authRouter, '/login')(req, res)
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    prisma.user.findUnique = originals.findUser
    prisma.$transaction = originals.transaction
  }

  assert.equal(res.statusCode, 200)
  assert.equal(createCalled, false)
  assert.equal(sentDeviceEmails.length, 0)
})

test('un appareil fiable se reconnecte sans challenge', async () => {
  const password = await bcrypt.hash('Test1234', 4)
  const originals = { findUser: prisma.user.findUnique, transaction: prisma.$transaction }
  let trustedUpdated = false
  let loginRecorded = false

  prisma.user.findUnique = async () => verifiedUser(password)
  prisma.$transaction = async callback => callback({
    $queryRawUnsafe: async () => [{ pg_advisory_xact_lock: null }],
    trustedDevice: {
      findUnique: async ({ where }) => (
        where.userId_deviceToken.deviceToken === DEVICE_TOKEN ? { id: 1 } : null
      ),
      update: async () => { trustedUpdated = true; return {} },
    },
    loginEvent: { create: async () => { loginRecorded = true; return {} } },
  })

  const req = {
    body: { email: 'alice@example.test', password: 'Test1234' },
    headers: {
      'user-agent': 'Safari iPhone',
      'x-device-token': '99999999-9999-4999-8999-999999999999',
    },
    cookies: { device_token: DEVICE_TOKEN },
  }
  const res = responseRecorder()

  try {
    await routeHandler(authRouter, '/login')(req, res)
  } finally {
    prisma.user.findUnique = originals.findUser
    prisma.$transaction = originals.transaction
  }

  assert.equal(res.statusCode, 200)
  assert.equal(trustedUpdated, true)
  assert.equal(loginRecorded, true)
  assert.equal(res.body.deviceToken, DEVICE_TOKEN)
})

test('un échec email retire le challenge pour permettre une nouvelle tentative', async () => {
  sentDeviceEmails.length = 0
  deviceEmailFailure = new Error('provider unavailable')
  const password = await bcrypt.hash('Test1234', 4)
  const originals = {
    findUser: prisma.user.findUnique,
    transaction: prisma.$transaction,
  }
  const retired = []
  const deletedNotifications = []
  let transactionNumber = 0
  prisma.user.findUnique = async () => verifiedUser(password)
  prisma.$transaction = async callback => {
    transactionNumber += 1
    if (transactionNumber === 1) {
      return callback({
        $queryRawUnsafe: async () => [{ pg_advisory_xact_lock: null }],
        trustedDevice: { findUnique: async () => null },
        deviceVerification: {
          updateMany: async () => ({ count: 0 }),
          findFirst: async () => null,
          create: async ({ data }) => ({ ...data, token: 'unsent-token', createdAt: new Date() }),
        },
        notification: { create: async () => ({}) },
        loginEvent: { create: async () => ({}) },
      })
    }
    return callback({
      deviceVerification: {
        updateMany: async args => { retired.push(args); return { count: 1 } },
      },
      notification: {
        deleteMany: async args => { deletedNotifications.push(args); return { count: 1 } },
      },
    })
  }
  const res = responseRecorder()

  try {
    await routeHandler(authRouter, '/login')({
      body: { email: 'alice@example.test', password: 'Test1234' },
      headers: { 'user-agent': 'Safari iPhone', 'x-device-token': DEVICE_TOKEN },
      cookies: {},
    }, res)
  } finally {
    prisma.user.findUnique = originals.findUser
    prisma.$transaction = originals.transaction
    deviceEmailFailure = null
  }

  assert.equal(res.statusCode, 200)
  assert.equal(retired.length, 1)
  assert.equal(retired[0].where.token, 'unsent-token')
  assert.equal(deletedNotifications.length, 1)
  assert.equal(deletedNotifications[0].where.deviceToken, DEVICE_TOKEN)
})

test('après un rejet, la connexion reste bloquée jusqu’au reset du mot de passe', async () => {
  const password = await bcrypt.hash('Test1234', 4)
  const originals = { findUser: prisma.user.findUnique, transaction: prisma.$transaction }
  let transactionCalled = false
  prisma.user.findUnique = async () => ({ ...verifiedUser(password), requiresPasswordReset: true })
  prisma.$transaction = async () => { transactionCalled = true }
  const res = responseRecorder()

  try {
    await routeHandler(authRouter, '/login')({
      body: { email: 'alice@example.test', password: 'Test1234' },
      headers: { 'user-agent': 'Safari iPhone', 'x-device-token': DEVICE_TOKEN },
      cookies: {},
    }, res)
  } finally {
    prisma.user.findUnique = originals.findUser
    prisma.$transaction = originals.transaction
  }

  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.body, { error: 'PASSWORD_RESET_REQUIRED' })
  assert.equal(transactionCalled, false)
  assert.equal(res.cookies.length, 0)
})

test('le GET de confiance ne modifie rien et le POST est transactionnel', async () => {
  const getRes = responseRecorder()
  await routeHandler(authRouter, '/device-verify', 'get')({ query: {} }, getRes)
  assert.equal(getRes.statusCode, 405)

  const originals = { transaction: prisma.$transaction }
  const calls = []
  prisma.$transaction = async callback => callback({
    deviceVerification: {
      findUnique: async () => ({
        userId: 42,
        deviceToken: DEVICE_TOKEN,
        deviceName: 'Safari sur iPhone',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      updateMany: async () => ({ count: 1 }),
    },
    trustedDevice: { upsert: async args => { calls.push(['trust', args]); return {} } },
    notification: { updateMany: async args => { calls.push(['notification', args]); return {} } },
  })
  const res = responseRecorder()
  try {
    await routeHandler(authRouter, '/device-verify-trust')({ body: { token: 'valid' } }, res)
  } finally {
    prisma.$transaction = originals.transaction
  }
  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls.map(([name]) => name), ['trust', 'notification'])
})

test('le rejet bloque le mot de passe et invalide tous les challenges', async () => {
  const originals = { transaction: prisma.$transaction }
  const calls = []
  prisma.$transaction = async callback => callback({
    deviceVerification: {
      findUnique: async () => ({ userId: 42, usedAt: null, expiresAt: new Date(Date.now() + 60_000) }),
      updateMany: async args => { calls.push(['verifications', args]); return { count: 1 } },
    },
    user: { update: async args => { calls.push(['user', args]); return {} } },
    trustedDevice: { deleteMany: async args => { calls.push(['trusted', args]); return {} } },
    pendingTrustedDevice: { deleteMany: async args => { calls.push(['pending', args]); return {} } },
    notification: { updateMany: async args => { calls.push(['notification', args]); return {} } },
  })
  const res = responseRecorder()
  try {
    await routeHandler(authRouter, '/device-verify-reject')({ body: { token: 'valid' } }, res)
  } finally {
    prisma.$transaction = originals.transaction
  }
  const userUpdate = calls.find(([name]) => name === 'user')[1]
  assert.equal(userUpdate.data.requiresPasswordReset, true)
  assert.deepEqual(userUpdate.data.tokenVersion, { increment: 1 })
  assert.equal(calls.filter(([name]) => name === 'verifications').length, 2)
  assert.ok(calls.some(([name]) => name === 'trusted'))
  assert.ok(calls.some(([name]) => name === 'pending'))
})

test('la validation email ne fait confiance qu’au navigateur d’inscription', async () => {
  const getRes = responseRecorder()
  await routeHandler(authRouter, '/verify-email', 'get')({}, getRes)
  assert.equal(getRes.statusCode, 405)

  const originals = { transaction: prisma.$transaction }
  let trustCreated = false
  prisma.$transaction = async callback => callback({
    user: {
      findUnique: async () => ({ id: 42 }),
      updateMany: async () => ({ count: 1 }),
    },
    pendingTrustedDevice: {
      findUnique: async () => ({
        deviceToken: DEVICE_TOKEN,
        name: 'Safari sur iPhone',
        userAgent: 'Safari iPhone',
        expiresAt: new Date(Date.now() + 60_000),
      }),
      deleteMany: async () => ({}),
    },
    trustedDevice: { upsert: async () => { trustCreated = true; return {} } },
  })
  const res = responseRecorder()
  try {
    await routeHandler(authRouter, '/verify-email')({
      body: { token: 'email-token' },
      headers: { 'x-device-token': DEVICE_TOKEN },
      cookies: {},
    }, res)
  } finally {
    prisma.$transaction = originals.transaction
  }
  assert.equal(res.statusCode, 200)
  assert.equal(trustCreated, true)
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
    deviceToken: DEVICE_TOKEN,
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
