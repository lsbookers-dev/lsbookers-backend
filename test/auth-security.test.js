const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')

process.env.JWT_SECRET = 'test-secret-for-auth-security'

const prisma = require('../prisma/client')
const emailModulePath = require.resolve('../utils/email')
const originalEmailModule = require(emailModulePath)

require.cache[emailModulePath].exports = {
  ...originalEmailModule,
  sendVerificationEmail: async () => {},
  sendNewDeviceEmail: async () => {},
}

const { requireAuth } = require('../middleware/auth')
const authRouter = require('../routes/auth')
const passwordRouter = require('../routes/password')

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    cookies: [],
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    cookie(name, value, options) {
      this.cookies.push({ name, value, options })
      return this
    },
  }
}

function routeHandler(router, path) {
  const layer = router.stack.find(item => item.route?.path === path)
  assert.ok(layer, `Route ${path} introuvable`)
  return layer.route.stack.at(-1).handle
}

async function runRequireAuth(payload, user) {
  const originalFindUnique = prisma.user.findUnique
  prisma.user.findUnique = async () => user
  const req = {
    headers: { authorization: `Bearer ${jwt.sign(payload, process.env.JWT_SECRET)}` },
    cookies: {},
  }
  const res = responseRecorder()
  let nextCalled = false

  try {
    await requireAuth(req, res, () => { nextCalled = true })
  } finally {
    prisma.user.findUnique = originalFindUnique
  }

  return { req, res, nextCalled }
}

const verifiedUser = {
  id: 42,
  pseudo: 'alice',
  firstName: 'Alice',
  lastName: 'Test',
  email: 'alice@example.test',
  role: 'ARTIST',
  isAdmin: false,
  registrationStep: 3,
  emailVerified: true,
  tokenVersion: 2,
  profile: { id: 7, avatar: null, banner: null },
}

test('requireAuth refuse un JWT hérité sans tokenVersion', async () => {
  const result = await runRequireAuth({ id: 42 }, verifiedUser)
  assert.equal(result.res.statusCode, 401)
  assert.equal(result.nextCalled, false)
})

test('requireAuth refuse un compte dont l’email n’est pas vérifié', async () => {
  const result = await runRequireAuth(
    { id: 42, tokenVersion: 2 },
    { ...verifiedUser, emailVerified: false },
  )
  assert.equal(result.res.statusCode, 403)
  assert.deepEqual(result.res.body, { error: 'EMAIL_NOT_VERIFIED' })
  assert.equal(result.nextCalled, false)
})

test('requireAuth accepte un compte vérifié avec la bonne version', async () => {
  const result = await runRequireAuth({ id: 42, tokenVersion: 2 }, verifiedUser)
  assert.equal(result.nextCalled, true)
  assert.equal(result.req.user.id, 42)
})

test('register-complete ne renvoie aucune session ni token email', async () => {
  const originals = {
    findUnique: prisma.user.findUnique,
    createUser: prisma.user.create,
    createDevice: prisma.trustedDevice.create,
  }
  prisma.user.findUnique = async () => null
  prisma.user.create = async ({ data }) => ({
    id: 42,
    ...data,
    password: 'hashed-password',
    tokenVersion: 0,
    profile: { id: 7 },
  })
  prisma.trustedDevice.create = async () => ({ id: 1 })

  const handler = routeHandler(authRouter, '/register-complete')
  const req = {
    body: {
      email: 'new@example.test',
      password: 'Test1234',
      role: 'ARTIST',
      pseudo: 'new-user',
      firstName: 'New',
      lastName: 'User',
      countryOfResidence: 'France',
      specialties: [],
    },
    headers: { 'user-agent': 'Test browser' },
  }
  const res = responseRecorder()

  try {
    await handler(req, res)
  } finally {
    prisma.user.findUnique = originals.findUnique
    prisma.user.create = originals.createUser
    prisma.trustedDevice.create = originals.createDevice
  }

  assert.equal(res.statusCode, 201)
  assert.equal(res.body.requiresEmailVerification, true)
  assert.equal(typeof res.body.deviceToken, 'string')
  assert.equal('token' in res.body, false)
  assert.equal('user' in res.body, false)
  assert.equal('emailVerificationToken' in res.body, false)
  assert.deepEqual(res.cookies.map(cookie => cookie.name), ['device_token'])
})

test('reset-password révoque les sessions et refuse une réutilisation concurrente', async () => {
  const oldPassword = '$2b$10$FAPfSmIR9Yz4sZL3R6xZguO6Vw0F8uyOvpc07MECE8fP0mHqXGG0m'
  const originals = {
    findReset: prisma.passwordReset.findUnique,
    findUser: prisma.user.findUnique,
    transaction: prisma.$transaction,
  }
  const userUpdates = []
  let resetClaimed = false
  prisma.passwordReset.findUnique = async () => ({
    userId: 42,
    usedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  })
  prisma.user.findUnique = async () => ({ password: oldPassword })
  prisma.$transaction = async callback => callback({
    passwordReset: {
      updateMany: async args => {
        if (resetClaimed) return { count: 0 }
        resetClaimed = true
        assert.equal(args.where.usedAt, null)
        assert.ok(args.where.expiresAt.gt instanceof Date)
        return { count: 1 }
      },
    },
    user: {
      update: async args => { userUpdates.push(args); return {} },
    },
  })

  const handler = routeHandler(passwordRouter, '/reset-password')
  const req1 = { body: { token: 'valid-reset-token', password: 'Different1234' } }
  const req2 = { body: { token: 'valid-reset-token', password: 'Another1234' } }
  const res1 = responseRecorder()
  const res2 = responseRecorder()

  try {
    await Promise.all([handler(req1, res1), handler(req2, res2)])
  } finally {
    prisma.passwordReset.findUnique = originals.findReset
    prisma.user.findUnique = originals.findUser
    prisma.$transaction = originals.transaction
  }

  assert.deepEqual([res1.statusCode, res2.statusCode].sort(), [200, 400])
  assert.equal(userUpdates.length, 1)
  assert.deepEqual(userUpdates[0].data.tokenVersion, { increment: 1 })
  assert.ok(userUpdates[0].data.password)
})
