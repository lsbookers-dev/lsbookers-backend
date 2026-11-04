process.env.LSB_DISABLE_EMAILS = '1'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-connexion'
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test'

const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')

const prisma = require('../prisma/client')
const { issueSession, renewSessionIfDue, deviceNameFromUA } = require('../lib/sessions')
const { signSecureAccountToken, userFromSecureToken } = require('../lib/secureAccount')

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
const HINT = '3f2b8c1e-4d5a-4b6c-9d7e-1a2b3c4d5e6f'

function responseRecorder() {
  return { cookies: [], cookie(name, value, options) { this.cookies.push({ name, value, options }) } }
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

const user = { id: 7, email: 'a@b.fr', role: 'ARTIST', isAdmin: false, tokenVersion: 2 }

test('appareil reconnu par l’identifiant du site même si Safari a effacé le cookie', async () => {
  let where
  const res = responseRecorder()
  const result = await withMocks({
    userSession: {
      findFirst: async (a) => { where = a.where; return { id: 1 } },
      count: async () => 3,
      create: async ({ data }) => data,
    },
  }, () => issueSession({ headers: { 'user-agent': IPHONE }, cookies: {} }, res, user, { deviceHint: HINT }))
  assert.deepEqual(where.OR[1], { deviceHint: HINT })
  assert.equal(result.isNewDevice, false)
})

test('application installée sur un iPhone déjà connecté : pas d’alerte, nom distinct', async () => {
  const res = responseRecorder()
  let created
  const result = await withMocks({
    userSession: {
      findFirst: async (a) => (a.where.name ? { id: 9 } : null), // inconnu… mais une session « sur iPhone » active existe
      count: async () => 2,
      create: async ({ data }) => { created = data; return data },
    },
  }, () => issueSession({ headers: { 'user-agent': IPHONE }, cookies: {} }, res, user, { standalone: true }))
  assert.equal(result.isNewDevice, false)
  assert.equal(created.name, 'Application LS Bookers sur iPhone')
})

test('vrai nouvel appareil : alerte', async () => {
  const result = await withMocks({
    userSession: { findFirst: async () => null, count: async () => 2, create: async ({ data }) => data },
  }, () => issueSession({ headers: { 'user-agent': IPHONE }, cookies: {} }, responseRecorder(), user, { deviceHint: 'pas-un-uuid' }))
  assert.equal(result.isNewDevice, true)
  assert.equal(deviceNameFromUA(IPHONE), 'Safari sur iPhone')
})

test('connexion prolongée : nouveau jeton de 30 jours après un jour, pas avant, jamais pour l’admin', () => {
  const day = 24 * 3600
  const now = Math.floor(Date.now() / 1000)
  const res1 = responseRecorder()
  assert.equal(renewSessionIfDue({}, res1, { decoded: { iat: now - 2 * day }, user, sid: 'abc', fromCookie: true }), true)
  const renewed = jwt.verify(res1.cookies[0].value, process.env.JWT_SECRET)
  assert.equal(renewed.sid, 'abc')
  assert.ok(renewed.exp - renewed.iat >= 30 * day - 5)
  assert.equal(renewSessionIfDue({}, responseRecorder(), { decoded: { iat: now - 3600 }, user, sid: 'abc', fromCookie: true }), false)
  assert.equal(renewSessionIfDue({}, responseRecorder(), { decoded: { iat: now - 2 * day }, user: { ...user, role: 'ADMIN' }, sid: 'abc', fromCookie: true }), false)
  assert.equal(renewSessionIfDue({}, responseRecorder(), { decoded: { iat: now - 2 * day }, user, sid: 'abc', fromCookie: false }), false)
})

test('« Ce n’était pas moi » : lien valable une seule fois', async () => {
  const token = signSecureAccountToken(user)
  const ok = await withMocks({ user: { findUnique: async () => ({ id: 7, email: 'a@b.fr', tokenVersion: 2 }) } }, () => userFromSecureToken(token))
  assert.equal(ok.id, 7)
  // Après usage, la version du compte a changé : le même lien est refusé
  const used = await withMocks({ user: { findUnique: async () => ({ id: 7, email: 'a@b.fr', tokenVersion: 3 }) } }, () => userFromSecureToken(token))
  assert.equal(used, null)
  assert.equal(await userFromSecureToken('faux'), null)
  // Un jeton de session ne peut pas servir de lien de sécurisation
  const session = jwt.sign({ id: 7, tokenVersion: 2 }, process.env.JWT_SECRET)
  assert.equal(await userFromSecureToken(session), null)
})
