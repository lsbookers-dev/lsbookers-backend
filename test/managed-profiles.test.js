// Profils gérés : un compte normal ne voit aucun changement, un agent n'agit pour
// un profil qu'avec une gestion active, et jamais sur les identifiants ni l'argent.
process.env.LSB_DISABLE_EMAILS = '1'
process.env.JWT_SECRET = 'test-secret-for-managed-profiles'

const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')

const prisma = require('../prisma/client')
const emailModulePath = require.resolve('../utils/email')
require.cache[emailModulePath] = {
  id: emailModulePath, filename: emailModulePath, loaded: true,
  exports: { sendManagedProfileInviteEmail: async () => {}, sendNotificationEmail: async () => {} },
}

const { requireAuth } = require('../middleware/auth')
const { isBlockedWhileActing, hidePrivateFromManager } = require('../lib/managedProfiles')
const bookingRouter = require('../routes/event-bookings')
const managersRouter = require('../routes/managers')

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
  try {
    return await fn()
  } finally {
    for (const [model, name, original] of originals) prisma[model][name] = original
  }
}

const AGENT = {
  id: 1, pseudo: 'Sud Booking', firstName: null, lastName: null, email: 'agence@example.test', role: 'ORGANIZER',
  isAdmin: false, registrationStep: 4, emailVerified: true, tokenVersion: 0, pausedAt: null, bannedAt: null,
  canManageProfiles: true, profile: { id: 10, avatar: null, banner: null },
}
const ARTIST = {
  id: 2, pseudo: 'Nina Vega', firstName: 'Nina', lastName: 'Vega', email: 'nina@example.test', role: 'ARTIST',
  isAdmin: false, registrationStep: 4, emailVerified: true, tokenVersion: 0, pausedAt: null, bannedAt: null,
  canManageProfiles: false, profile: { id: 20, avatar: null, banner: null },
}

const usersById = { 1: AGENT, 2: ARTIST }

async function runAuth({ userId, actAs, method = 'GET', url = '/api/events/booking-requests', management = null }) {
  const req = {
    method,
    originalUrl: url,
    headers: {
      authorization: `Bearer ${jwt.sign({ id: userId, tokenVersion: 0 }, process.env.JWT_SECRET)}`,
      ...(actAs ? { 'x-act-as-profile': String(actAs) } : {}),
    },
    cookies: {},
  }
  const res = responseRecorder()
  let nextCalled = false
  await withMocks({
    user: { findUnique: async ({ where }) => usersById[where.id] || null },
    profileManager: { findFirst: async () => management },
  }, () => requireAuth(req, res, () => { nextCalled = true }))
  return { req, res, nextCalled }
}

const ACTIVE = { id: 5, profileId: 20, requireApproval: true, profile: { userId: 2 } }

// ── Compte normal : rien ne change ─────────────────────────

test('compte normal sans en-tête : même utilisateur, pas d’agent', async () => {
  const { req, nextCalled } = await runAuth({ userId: 2 })
  assert.equal(nextCalled, true)
  assert.equal(req.user.id, 2)
  assert.equal(req.actor, undefined)
  assert.equal(req.management, undefined)
})

test('compte normal : ses propres réglages restent accessibles', async () => {
  const { nextCalled, res } = await runAuth({ userId: 2, method: 'PUT', url: '/api/account/password' })
  assert.equal(nextCalled, true)
  assert.equal(res.statusCode, 200)
})

test('en-tête égal à son propre profil : traité comme un compte normal', async () => {
  const { req, nextCalled } = await runAuth({ userId: 2, actAs: 20 })
  assert.equal(nextCalled, true)
  assert.equal(req.user.id, 2)
  assert.equal(req.actor, undefined)
})

// ── Agent ──────────────────────────────────────────────────

test('agent avec une gestion active : agit avec le compte de l’artiste', async () => {
  const { req, nextCalled } = await runAuth({ userId: 1, actAs: 20, management: ACTIVE })
  assert.equal(nextCalled, true)
  assert.equal(req.user.id, 2)
  assert.equal(req.actor.id, 1)
  assert.deepEqual(req.management, { id: 5, profileId: 20, requireApproval: true })
})

test('agent sans gestion active (retirée par l’artiste) : refusé', async () => {
  const { res, nextCalled } = await runAuth({ userId: 1, actAs: 20, management: null })
  assert.equal(nextCalled, false)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error, 'MANAGEMENT_ENDED')
})

test('compte sans la fonction activée : ne peut agir pour personne', async () => {
  const { res, nextCalled } = await runAuth({ userId: 2, actAs: 10, management: { ...ACTIVE, profileId: 10, profile: { userId: 1 } } })
  assert.equal(nextCalled, false)
  assert.equal(res.body.error, 'MANAGEMENT_ENDED')
})

for (const [method, url] of [
  ['PUT', '/api/account/password'],
  ['POST', '/api/account/email'],
  ['DELETE', '/api/auth/account'],
  ['POST', '/api/auth/reset-password'],
  ['PUT', '/api/profile/me/account'],
  ['POST', '/api/billing/checkout'],
  ['POST', '/api/payouts/withdraw'],
  ['POST', '/api/payouts/onboard'],
  ['POST', '/api/booking-payments/12/online'],
]) {
  test(`agent : ${method} ${url} est réservé au titulaire`, async () => {
    const { res, nextCalled } = await runAuth({ userId: 1, actAs: 20, management: ACTIVE, method, url })
    assert.equal(nextCalled, false)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.error, 'MANAGED_FORBIDDEN')
  })
}

test('liste des routes interdites : le quotidien reste permis', () => {
  assert.equal(isBlockedWhileActing('GET', '/api/auth/me'), false)
  assert.equal(isBlockedWhileActing('POST', '/api/auth/logout'), false)
  assert.equal(isBlockedWhileActing('GET', '/api/billing/me'), false)
  assert.equal(isBlockedWhileActing('PATCH', '/api/events/booking-request/3'), false)
  assert.equal(isBlockedWhileActing('POST', '/api/messages/send'), false)
  assert.equal(isBlockedWhileActing('PUT', '/api/profile/20'), false)
  assert.equal(isBlockedWhileActing('POST', '/api/publications'), false)
  assert.equal(isBlockedWhileActing('GET', '/api/account/settings?x=1'), true)
  assert.equal(isBlockedWhileActing('PATCH', '/api/accounting'), false)
})

test('l’agent ne voit pas les données personnelles de l’artiste', () => {
  const safe = hidePrivateFromManager({ ...ARTIST, phone: '0600000000', dateOfBirth: new Date(), stripeAccountId: 'acct_1' })
  for (const key of ['email', 'phone', 'dateOfBirth', 'stripeAccountId']) assert.equal(key in safe, false, key)
  assert.equal(safe.pseudo, 'Nina Vega')
})

// ── Accord de l'artiste avant booking ──────────────────────

const BOOKING = {
  id: 77, status: 'PENDING', requesterId: 30, targetId: 20, startDate: new Date('2026-11-14'), awaitingArtistSince: null,
  requester: { id: 30, userId: 3, user: { pseudo: 'Le Rex' } },
  target: { id: 20, userId: 2, user: { pseudo: 'Nina Vega', role: 'ARTIST' } },
}

function bookingMocks(updates, extra = {}) {
  return {
    profile: { findUnique: async () => ({ id: 20 }) },
    bookingRequest: {
      findUnique: async () => ({ ...BOOKING, ...extra }),
      update: async ({ data }) => { updates.push(data); return { ...BOOKING, ...data } },
    },
    message: { findFirst: async () => null },
    user: { findUnique: async () => ({ email: null, notifPrefs: null }) },
    notification: { create: async () => ({}) },
    availability: { upsert: async () => ({}) },
    event: { findFirst: async () => ({ id: 900 }), create: async () => ({ id: 900 }) },
    eventStaff: { findFirst: async () => ({ id: 1, status: 'BOOKED', fee: 100 }), update: async () => ({}) },
    offer: { findMany: async () => [] },
  }
}

const patchBooking = routeHandler(bookingRouter, 'patch', '/booking-request/:id')

test('compte normal : accepter un booking l’accepte tout de suite (inchangé)', async () => {
  const updates = []
  const res = responseRecorder()
  await withMocks(bookingMocks(updates), () => patchBooking({ params: { id: '77' }, body: { status: 'ACCEPTED' }, user: ARTIST }, res))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(updates[0], { status: 'ACCEPTED' })
})

test('agent avec « accord de l’artiste » : le booking attend la confirmation', async () => {
  const updates = []
  const res = responseRecorder()
  await withMocks(bookingMocks(updates), () => patchBooking({
    params: { id: '77' }, body: { status: 'ACCEPTED' }, user: ARTIST, actor: AGENT, management: { profileId: 20, requireApproval: true },
  }, res))
  assert.equal(res.body.awaitingArtist, true)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].status, undefined, 'le statut ne doit pas changer')
  assert.ok(updates[0].awaitingArtistSince instanceof Date)
  assert.equal(updates[0].approvalRequestedById, 1)
})

test('agent sans « accord de l’artiste » : accepte directement', async () => {
  const updates = []
  const res = responseRecorder()
  await withMocks(bookingMocks(updates), () => patchBooking({
    params: { id: '77' }, body: { status: 'ACCEPTED' }, user: ARTIST, actor: AGENT, management: { profileId: 20, requireApproval: false },
  }, res))
  assert.deepEqual(updates[0], { status: 'ACCEPTED' })
})

test('l’artiste confirme : le booking est accepté et l’attente effacée', async () => {
  const updates = []
  const res = responseRecorder()
  await withMocks(bookingMocks(updates, { awaitingArtistSince: new Date() }), () => patchBooking({ params: { id: '77' }, body: { status: 'ACCEPTED' }, user: ARTIST }, res))
  assert.deepEqual(updates[0], { status: 'ACCEPTED', awaitingArtistSince: null, approvalRequestedById: null })
})

// ── Côté artiste : un agent ne répond jamais à sa place ────

test('un agent ne peut pas retirer ni accepter une gestion à la place de l’artiste', async () => {
  for (const [method, path] of [['get', '/mine'], ['post', '/mine/:id/accept'], ['delete', '/mine/:id']]) {
    const layer = managersRouter.stack.find(item => item.route?.path === path && item.route.methods[method])
    const ownerGuard = layer.route.stack.at(-2).handle
    const res = responseRecorder()
    let nextCalled = false
    await ownerGuard({ user: ARTIST, actor: AGENT }, res, () => { nextCalled = true })
    assert.equal(nextCalled, false, path)
    assert.equal(res.body.error, 'MANAGED_FORBIDDEN')
  }
})

test('l’artiste retire l’accès : la gestion passe à ENDED et l’agence est prévenue', async () => {
  const updates = []
  const notifs = []
  const res = responseRecorder()
  await withMocks({
    profileManager: {
      findFirst: async () => ({ id: 5, status: 'ACTIVE', managerUserId: 1, profileId: 20, manager: { id: 1, pseudo: 'Sud Booking', profile: null } }),
      update: async ({ data }) => { updates.push(data); return {} },
    },
    user: { findUnique: async () => ({ email: null, notifPrefs: null }) },
    notification: { create: async ({ data }) => { notifs.push(data); return {} } },
  }, () => routeHandler(managersRouter, 'delete', '/mine/:id')({ params: { id: '5' }, user: ARTIST }, res))
  assert.equal(res.body.ok, true)
  assert.equal(updates[0].status, 'ENDED')
  assert.equal(updates[0].endedBy, 'ARTIST')
  assert.equal(notifs[0].userId, 1)
})
