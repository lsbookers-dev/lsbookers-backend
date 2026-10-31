// Sécurité de l'admin (31/10/2026) : code par e-mail, session courte, journal, suppression de compte
process.env.LSB_DISABLE_EMAILS = '1'
process.env.JWT_SECRET = 'test-secret-admin'

const test = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')

const prisma = require('../prisma/client')
const emailUtils = require('../utils/email')
const sentCodes = []
emailUtils.sendAdminLoginCodeEmail = async (to, { code }) => { sentCodes.push({ to, code }) }
emailUtils.sendLoginAlertEmail = async () => {}
const authRouter = require('../routes/auth')
const { authenticate } = require('../middleware/auth')
const { adminSessionProblem } = require('../lib/sessions')
const { matchAction, safeDetails } = require('../lib/adminAudit')
const stripeLib = require('../lib/stripe')

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

/** Remplace des fonctions Prisma le temps d'un test (aucune vraie base) */
async function withMocks(mocks, fn) {
  const saved = mocks.map(([obj, key]) => [obj, key, obj[key]])
  for (const [obj, key, value] of mocks) obj[key] = value
  try { return await fn() } finally { for (const [obj, key, value] of saved) obj[key] = value }
}

const adminUser = (password) => ({
  id: 1, email: 'admin@lsbookers.com', password, role: 'ADMIN', isAdmin: true,
  emailVerified: true, requiresPasswordReset: false, tokenVersion: 2, profile: null,
})

test('session admin : refusée sans code, après 1 h sans activité ou 6 h après la connexion', () => {
  const now = Date.now()
  const fresh = { createdAt: new Date(now - 60_000), lastUsedAt: new Date(now - 60_000) }
  assert.equal(adminSessionProblem({ adm: true }, fresh, now), null)
  assert.equal(adminSessionProblem({}, fresh, now), 'ADMIN_CODE_REQUIRED')
  assert.equal(adminSessionProblem({ adm: true }, null, now), 'ADMIN_CODE_REQUIRED')
  assert.equal(adminSessionProblem({ adm: true }, { ...fresh, lastUsedAt: new Date(now - 61 * 60_000) }, now), 'ADMIN_SESSION_EXPIRED')
  assert.equal(adminSessionProblem({ adm: true }, { createdAt: new Date(now - 6 * 3600_000 - 1000), lastUsedAt: new Date(now) }, now), 'ADMIN_SESSION_EXPIRED')
})

test('admin : le bon mot de passe envoie un code, sans ouvrir de session', async () => {
  const password = await bcrypt.hash('Admin1234', 4)
  const codes = []
  const res = responseRecorder()
  await withMocks([
    [prisma.user, 'findUnique', async () => adminUser(password)],
    [prisma.adminLoginCode, 'updateMany', async () => ({ count: 0 })],
    [prisma.adminLoginCode, 'create', async ({ data }) => { codes.push(data); return data }],
    [prisma.adminLog, 'create', async ({ data }) => data],
  ], () => routeHandler(authRouter, '/login')({
    body: { email: 'admin@lsbookers.com', password: 'Admin1234' }, headers: { 'user-agent': 'Chrome Mac' }, cookies: {},
  }, res))

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.twoFactorRequired, true)
  assert.match(res.body.challenge, /^[a-f0-9]{48}$/)
  assert.equal(res.body.user, undefined)
  assert.equal(res.cookies.length, 0)
  assert.equal(codes.length, 1)
  assert.notEqual(codes[0].codeHash, sentCodes.at(-1).code) // le code n'est jamais gardé en clair
  assert.match(sentCodes.at(-1).code, /^\d{6}$/)
  assert.equal(sentCodes.at(-1).to, 'admin@lsbookers.com')
})

test('admin : mauvais code refusé, bon code ouvre une session admin de 6 h', async () => {
  const password = await bcrypt.hash('Admin1234', 4)
  let stored = null
  const loginRes = responseRecorder()
  await withMocks([
    [prisma.user, 'findUnique', async () => adminUser(password)],
    [prisma.adminLoginCode, 'updateMany', async () => ({ count: 0 })],
    [prisma.adminLoginCode, 'create', async ({ data }) => { stored = { id: 9, attempts: 0, usedAt: null, ...data, userId: 1 }; return stored }],
    [prisma.adminLog, 'create', async ({ data }) => data],
  ], () => routeHandler(authRouter, '/login')({
    body: { email: 'admin@lsbookers.com', password: 'Admin1234' }, headers: {}, cookies: {},
  }, loginRes))
  const { challenge } = loginRes.body
  const good = sentCodes.at(-1).code
  const wrong = good === '000000' ? '111111' : '000000'

  const updates = []
  const sessions = []
  const mocks = [
    [prisma.adminLoginCode, 'findUnique', async () => stored],
    [prisma.adminLoginCode, 'update', async ({ data }) => { updates.push(data); Object.assign(stored, data); return stored }],
    [prisma.adminLoginCode, 'updateMany', async () => ({ count: 1 })],
    [prisma.user, 'findUnique', async () => adminUser(password)],
    [prisma.userSession, 'findFirst', async () => null],
    [prisma.userSession, 'count', async () => 0],
    [prisma.userSession, 'create', async ({ data }) => { sessions.push(data); return data }],
    [prisma.adminLog, 'create', async ({ data }) => data],
  ]

  const bad = responseRecorder()
  await withMocks(mocks, () => routeHandler(authRouter, '/admin-code')({ body: { challenge, code: wrong }, headers: {}, cookies: {} }, bad))
  assert.equal(bad.statusCode, 401)
  assert.equal(bad.body.error, 'ADMIN_CODE_WRONG')
  assert.equal(bad.body.attemptsLeft, 4)
  assert.equal(sessions.length, 0)

  const ok = responseRecorder()
  await withMocks(mocks, () => routeHandler(authRouter, '/admin-code')({ body: { challenge, code: good }, headers: {}, cookies: {} }, ok))
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.body.user.id, 1)
  assert.equal(sessions.length, 1)
  const cookie = ok.cookies.find(c => c.name === 'token')
  assert.equal(cookie.options.maxAge, 6 * 3600_000)
  const decoded = jwt.verify(cookie.value, process.env.JWT_SECRET)
  assert.equal(decoded.adm, true)
  assert.ok(decoded.exp - decoded.iat <= 6 * 3600)
})

test('admin : 5 mauvais codes annulent le code', async () => {
  const row = { id: 3, userId: 1, challenge: 'a'.repeat(48), codeHash: 'b'.repeat(64), attempts: 4, usedAt: null, expiresAt: new Date(Date.now() + 60_000) }
  const res = responseRecorder()
  await withMocks([
    [prisma.adminLoginCode, 'findUnique', async () => row],
    [prisma.adminLoginCode, 'update', async ({ data }) => Object.assign(row, data)],
    [prisma.adminLog, 'create', async ({ data }) => data],
  ], () => routeHandler(authRouter, '/admin-code')({ body: { challenge: row.challenge, code: '123456' }, headers: {}, cookies: {} }, res))
  assert.equal(res.statusCode, 401)
  assert.equal(res.body.error, 'ADMIN_CODE_EXPIRED')
  assert.ok(row.usedAt)
})

test('un jeton admin sans code (ancienne session) est refusé et la session fermée', async () => {
  const token = jwt.sign({ id: 1, tokenVersion: 2, sid: 'sid-admin' }, process.env.JWT_SECRET, { expiresIn: '7d' })
  const revoked = []
  const session = { id: 5, revokedAt: null, lastUsedAt: new Date(), createdAt: new Date() }
  const result = await withMocks([
    [prisma.user, 'findUnique', async () => ({ ...adminUser('x'), bannedAt: null, sessions: [session] })],
    [prisma.userSession, 'update', async ({ where }) => { revoked.push(where.id); return {} }],
  ], () => authenticate({ headers: { authorization: `Bearer ${token}` }, cookies: {} }))
  assert.equal(result.status, 401)
  assert.equal(result.error, 'ADMIN_CODE_REQUIRED')
  assert.deepEqual(revoked, [5])
})

test('journal : actions reconnues, compte visé, rien de secret gardé', () => {
  assert.deepEqual(matchAction('DELETE', '/users/12'), { action: 'USER_DELETE', targetUserId: 12 })
  assert.deepEqual(matchAction('POST', '/billing/users/7/ban'), { action: 'USER_BAN', targetUserId: 7 })
  assert.deepEqual(matchAction('PUT', '/settings'), { action: 'SITE_SETTINGS', targetUserId: null })
  assert.equal(matchAction('PATCH', '/contact/4/read'), null)
  assert.equal(matchAction('POST', '/autre-chose').action, 'ADMIN_ACTION')
  assert.deepEqual(safeDetails({ reason: 'Spam', password: 'x', nested: { token: 'y', ok: 1 } }), { reason: 'Spam', nested: { ok: 1 } })
  assert.equal(safeDetails({}), null)
  assert.equal(safeDetails({ big: 'x'.repeat(5000) }).trop_long, true)
})

test('suppression de compte : abonnement Stripe arrêté à la fin de la période payée, sans remboursement', async () => {
  const { stopStripeSubscriptions } = require('../services/accountDeletion')
  const calls = []
  const fakeStripe = { subscriptions: { update: async (id, params) => { calls.push({ id, params }) } } }
  const original = stripeLib.getStripe
  stripeLib.getStripe = () => fakeStripe
  try {
    const stopped = await withMocks([
      [prisma.subscription, 'findUnique', async () => ({ stripeSubId: 'sub_pro', status: 'ACTIVE' })],
      [prisma.agencySubscription, 'findUnique', async () => ({ stripeSubId: 'sub_old', status: 'CANCELLED' })],
    ], () => stopStripeSubscriptions(42))
    assert.equal(stopped, 1)
    assert.deepEqual(calls, [{ id: 'sub_pro', params: { cancel_at_period_end: true } }])
  } finally {
    stripeLib.getStripe = original
  }
})

test('suppression de compte : bloquée si Stripe ne peut pas arrêter l’abonnement', async () => {
  const { stopStripeSubscriptions } = require('../services/accountDeletion')
  const original = stripeLib.getStripe
  stripeLib.getStripe = () => null
  try {
    await withMocks([
      [prisma.subscription, 'findUnique', async () => ({ stripeSubId: 'sub_pro', status: 'ACTIVE' })],
      [prisma.agencySubscription, 'findUnique', async () => null],
    ], () => assert.rejects(stopStripeSubscriptions(42)))
  } finally {
    stripeLib.getStripe = original
  }
})
