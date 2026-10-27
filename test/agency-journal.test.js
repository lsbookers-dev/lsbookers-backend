// Journal de l'agence, « envoyé par » et « Géré par » : uniquement quand une agence agit pour un profil géré.
process.env.LSB_DISABLE_EMAILS = '1'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const prisma = require('../prisma/client')
const { matchRule, logManagedActions } = require('../lib/managerLog')
const { sentByActor } = require('../lib/managedProfiles')

test('journal : les actions suivies, et rien pour les messages', () => {
  const req = (method, url, body = {}, management = { requireApproval: false }) => ({ method, originalUrl: url, body, management })
  assert.deepEqual(matchRule(req('PATCH', '/api/events/booking-request/12', { status: 'ACCEPTED' })), { action: 'BOOKING_ACCEPTED', id: 12 })
  assert.deepEqual(matchRule(req('PATCH', '/api/events/booking-request/12', { status: 'ACCEPTED' }, { requireApproval: true })), { action: 'BOOKING_APPROVAL_REQUESTED', id: 12 })
  assert.deepEqual(matchRule(req('POST', '/api/offers/7/apply')), { action: 'OFFER_APPLICATION', id: 7 })
  assert.deepEqual(matchRule(req('POST', '/api/publications')), { action: 'PUBLICATION', id: null })
  assert.equal(matchRule(req('POST', '/api/messages/send')), null)
  assert.equal(matchRule(req('GET', '/api/publications')), null)
})

async function runMiddleware(req, statusCode, mocks) {
  const created = []
  const original = prisma.managerActionLog.create
  prisma.managerActionLog.create = async ({ data }) => { created.push(data); return data }
  const res = new EventEmitter()
  res.statusCode = statusCode
  try {
    await new Promise(resolve => logManagedActions(req, res, resolve))
    res.emit('finish')
    await new Promise(r => setTimeout(r, 20))
  } finally {
    prisma.managerActionLog.create = original
  }
  return created
}

test('journal : rien n’est noté pour un compte normal (rien ne change)', async () => {
  const created = await runMiddleware({ method: 'POST', originalUrl: '/api/publications', body: {} }, 201)
  assert.equal(created.length, 0)
})

test('journal : action réussie d’une agence → une ligne', async () => {
  const created = await runMiddleware({
    method: 'POST', originalUrl: '/api/publications', body: {},
    actor: { id: 1 }, management: { profileId: 20, requireApproval: true },
  }, 201)
  assert.deepEqual(created, [{ managerUserId: 1, profileId: 20, action: 'PUBLICATION', detail: null }])
})

test('journal : action refusée (erreur) → rien', async () => {
  const created = await runMiddleware({
    method: 'POST', originalUrl: '/api/publications', body: {},
    actor: { id: 1 }, management: { profileId: 20 },
  }, 403)
  assert.equal(created.length, 0)
})

test('envoyé par : seulement quand une agence écrit', () => {
  assert.deepEqual(sentByActor({ user: { id: 2 } }), {})
  assert.deepEqual(sentByActor({ user: { id: 2 }, actor: { id: 1 } }), { sentByUserId: 1 })
})
