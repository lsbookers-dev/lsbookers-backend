const test = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcrypt')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-account'
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test'

const prisma = require('../prisma/client')
// Aucun vrai e-mail pendant les tests
const emailUtils = require('../utils/email')
for (const name of ['sendLoginAlertEmail', 'sendEmailChangeConfirmation', 'sendEmailChangedNotice', 'sendNotificationEmail', 'sendNewMessageEmail']) {
  emailUtils[name] = async () => {}
}
const accountRouter = require('../routes/account')
const { resolvePrefs, sanitizePrefs, wantsBell, wantsEmail } = require('../lib/notifPrefs')
const { deviceNameFromUA } = require('../lib/sessions')
const { newConversationRefusal } = require('../lib/messagePolicy')
const { createNotif } = require('../services/notifications')

function responseRecorder() {
  return {
    statusCode: 200, body: undefined, cookies: [], headers: {},
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    send(body) { this.body = body; return this },
    setHeader(k, v) { this.headers[k] = v },
    cookie(name, value) { this.cookies.push({ name, value }); return this },
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

// ── Choix de notifications ─────────────────────────────────
test('notifications : réglages par défaut et choix enregistrés', () => {
  const prefs = resolvePrefs({ network: { bell: false }, bookings: { email: false } })
  assert.equal(prefs.network.bell, false)
  assert.equal(prefs.network.email, false)
  assert.equal(prefs.bookings.bell, true)
  assert.equal(prefs.bookings.email, false)
  assert.equal(prefs.messages.bell, false, 'les messages ne passent jamais par la cloche')
  assert.equal(wantsBell(prefs, 'NEW_LIKE'), false)
  assert.equal(wantsBell(prefs, 'NEW_DEVICE_LOGIN'), true, 'sécurité : toujours dans la cloche')
  assert.equal(wantsEmail(resolvePrefs(null), 'BOOKING_REQUEST'), true)
  assert.equal(wantsEmail(resolvePrefs(null), 'NEW_LIKE'), false)
  assert.deepEqual(sanitizePrefs({ inconnu: { bell: true }, messages: { bell: true, email: false } }), { messages: { email: false } })
})

test('createNotif : cloche désactivée pour ce type → rien dans la cloche', async () => {
  let created = 0
  await withMocks({
    user: { findUnique: async () => ({ email: null, notifPrefs: { network: { bell: false } } }) },
    notification: { create: async () => { created++ } },
  }, async () => {
    await createNotif({ userId: 2, type: 'NEW_LIKE', content: 'x', actorId: 3 })
    await createNotif({ userId: 2, type: 'BOOKING_REQUEST', content: 'y', actorId: 3 })
  })
  assert.equal(created, 1)
})

// ── Réglages ───────────────────────────────────────────────
test('réglages : les choix de notifications sont fusionnés avec ceux déjà enregistrés', async () => {
  let saved
  await withMocks({
    user: {
      findUnique: async (a) => (a.select?.notifPrefs && !a.select?.email ? { notifPrefs: { network: { bell: false } } } : {
        email: 'a@b.fr', notifPrefs: saved, newsletterOptIn: false, loginAlerts: true, pausedAt: null, createdAt: new Date(), role: 'ARTIST',
        profile: { weeklyRecap: false, messagePolicy: 'EVERYONE', hiddenFromSearch: false },
      }),
      update: async ({ data }) => { saved = data.notifPrefs },
    },
    profile: { updateMany: async () => ({ count: 1 }) },
  }, async () => {
    const res = responseRecorder()
    await routeHandler(accountRouter, 'patch', '/settings')({ user: { id: 1 }, body: { notifPrefs: { network: { email: true } } } }, res)
    assert.deepEqual(saved, { network: { bell: false, email: true } })
    assert.equal(res.body.settings.notifPrefs.network.email, true)
  })
})

// ── Mot de passe ───────────────────────────────────────────
test('mot de passe : refusé si le mot de passe actuel est faux', async () => {
  const hash = await bcrypt.hash('Ancien123', 4)
  const res = responseRecorder()
  await withMocks({ user: { findUnique: async () => ({ id: 1, password: hash }) } }, () =>
    routeHandler(accountRouter, 'put', '/password')({ user: { id: 1 }, body: { currentPassword: 'Faux1234', newPassword: 'Nouveau123' }, headers: {}, cookies: {} }, res))
  assert.equal(res.statusCode, 401)
})

test('mot de passe : changé, autres appareils déconnectés, cet appareil reste connecté', async () => {
  const hash = await bcrypt.hash('Ancien123', 4)
  let revokedWhere, incremented = false
  const res = responseRecorder()
  await withMocks({
    user: {
      findUnique: async () => ({ id: 1, email: 'a@b.fr', role: 'ARTIST', isAdmin: false, tokenVersion: 2, password: hash }),
      update: async ({ data }) => { incremented = !!data.tokenVersion?.increment; return { id: 1, email: 'a@b.fr', role: 'ARTIST', isAdmin: false, tokenVersion: 3 } },
    },
    userSession: { updateMany: async ({ where }) => { revokedWhere = where; return { count: 2 } } },
  }, () => routeHandler(accountRouter, 'put', '/password')({
    user: { id: 1 }, sessionSid: 'abc', body: { currentPassword: 'Ancien123', newPassword: 'Nouveau123' }, headers: {}, cookies: {},
  }, res))
  assert.equal(res.statusCode, 200)
  assert.equal(incremented, true)
  assert.deepEqual(revokedWhere.sid, { not: 'abc' })
  assert.deepEqual(res.cookies.map(c => c.name), ['token'])
})

// ── Adresse e-mail ─────────────────────────────────────────
test('changement d’e-mail : adresse déjà prise refusée', async () => {
  const hash = await bcrypt.hash('Secret123', 4)
  const res = responseRecorder()
  await withMocks({
    user: { findUnique: async ({ where }) => (where.id ? { id: 1, email: 'a@b.fr', password: hash } : { id: 9 }) },
  }, () => routeHandler(accountRouter, 'post', '/email')({ user: { id: 1 }, body: { newEmail: 'pris@b.fr', password: 'Secret123' } }, res))
  assert.equal(res.statusCode, 409)
})

test('confirmation d’e-mail : lien expiré refusé', async () => {
  const res = responseRecorder()
  await withMocks({
    user: { findUnique: async () => ({ id: 1, email: 'a@b.fr', pendingEmail: 'n@b.fr', pendingEmailExpiresAt: new Date(Date.now() - 1000) }) },
  }, () => routeHandler(accountRouter, 'post', '/email/confirm')({ body: { token: 'x'.repeat(64) } }, res))
  assert.equal(res.statusCode, 400)
})

// ── Appareils ──────────────────────────────────────────────
test('appareils : l’appareil actuel est signalé, et ne se retire pas depuis la liste', async () => {
  const list = responseRecorder()
  const del = responseRecorder()
  await withMocks({
    userSession: {
      findMany: async () => [{ id: 1, sid: 'abc', name: 'Safari sur iPhone' }, { id: 2, sid: 'def', name: 'Chrome sur Mac' }],
      findFirst: async () => ({ id: 1, sid: 'abc' }),
    },
  }, async () => {
    await routeHandler(accountRouter, 'get', '/sessions')({ user: { id: 1 }, sessionSid: 'abc' }, list)
    await routeHandler(accountRouter, 'delete', '/sessions/:id')({ user: { id: 1 }, sessionSid: 'abc', params: { id: '1' } }, del)
  })
  assert.deepEqual(list.body.sessions.map(s => s.current), [true, false])
  assert.equal(list.body.sessions[0].sid, undefined, 'l’identifiant secret ne sort pas')
  assert.equal(del.statusCode, 400)
})

test('nom d’appareil lisible', () => {
  assert.equal(deviceNameFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari sur iPhone')
  assert.equal(deviceNameFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36'), 'Chrome sur Mac')
  assert.equal(deviceNameFromUA(''), 'Appareil inconnu')
})

// ── Confidentialité ────────────────────────────────────────
test('« qui peut m’écrire » : seulement les membres suivis, et compte en pause', async () => {
  await withMocks({
    user: { findUnique: async () => ({ pausedAt: null, profile: { messagePolicy: 'FOLLOWED' } }) },
    follow: { findFirst: async () => null },
  }, async () => {
    assert.equal((await newConversationRefusal(1, 2)).code, 'MESSAGES_RESTRICTED')
  })
  await withMocks({
    user: { findUnique: async () => ({ pausedAt: null, profile: { messagePolicy: 'FOLLOWED' } }) },
    follow: { findFirst: async () => ({ id: 1 }) },
  }, async () => {
    assert.equal(await newConversationRefusal(1, 2), null)
  })
  await withMocks({
    user: { findUnique: async () => ({ pausedAt: new Date(), profile: { messagePolicy: 'EVERYONE' } }) },
  }, async () => {
    assert.equal((await newConversationRefusal(1, 2)).code, 'ACCOUNT_PAUSED')
  })
})

// ── Mes données ────────────────────────────────────────────
test('export : fichier JSON à télécharger, sans mot de passe', async () => {
  const res = responseRecorder()
  const empty = { findMany: async () => [] }
  await withMocks({
    user: { findUnique: async () => ({ id: 1, email: 'a@b.fr', profile: { id: 7 } }) },
    publication: empty, publicationComment: empty, publicationLike: empty, follow: empty, block: empty, message: empty,
    bookingRequest: empty, review: empty, offer: empty, application: empty, event: empty, availability: empty, album: empty,
    notification: empty, userSession: empty,
  }, () => routeHandler(accountRouter, 'get', '/export')({ user: { id: 1 } }, res))
  assert.match(res.headers['Content-Disposition'], /attachment; filename="lsbookers-mes-donnees-/)
  const data = JSON.parse(res.body)
  assert.equal(data.account.email, 'a@b.fr')
  assert.equal(data.account.password, undefined)
})

test('e-mail « nouveau message » : seulement si absent du site, au plus une fois par heure', async () => {
  const { notifyNewMessageByEmail } = require('../services/messageEmails')
  const updated = []
  const ago = (min) => new Date(Date.now() - min * 60000)
  const part = (id, user, lastEmailedAt = null) => ({ id, lastEmailedAt, user: { email: `${id}@b.fr`, emailVerified: true, notifPrefs: null, ...user } })
  await withMocks({
    user: { findUnique: async () => ({ pseudo: 'Kalia' }) },
    conversationParticipant: {
      findMany: async () => [
        part(1, { lastActiveAt: ago(2) }),                 // sur le site → rien
        part(2, { lastActiveAt: ago(30) }),                // absent → e-mail
        part(3, { lastActiveAt: ago(30) }, ago(20)),       // e-mail il y a 20 min → rien
        part(4, { lastActiveAt: null, notifPrefs: { messages: { email: false } } }), // désactivé → rien
      ],
      update: async ({ where }) => { updated.push(where.id) },
    },
  }, () => notifyNewMessageByEmail({ conversationId: 5, senderId: 9 }))
  assert.deepEqual(updated, [2])
})
