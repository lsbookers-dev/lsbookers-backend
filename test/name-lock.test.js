process.env.LSB_DISABLE_EMAILS = '1'
const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const profileRouter = require('../routes/profile')
const { nameStatus } = require('../services/nameLock')

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    set() { return this },
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

const DAY = 864e5

test('nom : libre 7 jours après l’inscription, figé ensuite ou si Stripe a vérifié l’identité', () => {
  const now = new Date('2026-11-07T12:00:00Z')
  assert.equal(nameStatus({ createdAt: new Date(now - 3 * DAY) }, now).locked, false)
  assert.equal(nameStatus({ createdAt: new Date(now - 8 * DAY) }, now).reason, 'DELAY')
  assert.equal(nameStatus({ createdAt: new Date(now - DAY), isIdentityVerified: true }, now).reason, 'VERIFIED')
})

async function putAccount(body, user) {
  const res = responseRecorder()
  let saved = false
  await withMocks({
    profile: { findUnique: async () => ({ id: 1, legalStatus: null, siret: null }), update: async () => ({}) },
    user: { findFirst: async () => null, findUnique: async () => user, update: async () => ({}) },
  }, async () => {
    const original = prisma.$transaction
    prisma.$transaction = async () => { saved = true }
    try { await routeHandler(profileRouter, 'put', '/me/account')({ user: { id: 10 }, body }, res) } finally { prisma.$transaction = original }
  })
  return { res, saved }
}

test('nom figé : changement refusé, mais renvoyer le même nom passe (pseudo modifiable)', async () => {
  const old = { firstName: 'Alba', lastName: 'Martin', createdAt: new Date(Date.now() - 30 * DAY), isIdentityVerified: false }
  const refused = await putAccount({ firstName: 'Alberte', lastName: 'Martin' }, old)
  assert.equal(refused.res.statusCode, 403)
  assert.equal(refused.saved, false)
  const same = await putAccount({ pseudo: 'ALBA2', firstName: 'Alba', lastName: 'Martin' }, old)
  assert.equal(same.res.statusCode, 200)
  assert.ok(same.saved)
})

test('nom pendant les 7 premiers jours : modifiable', async () => {
  const fresh = { firstName: 'Alba', lastName: 'Martn', createdAt: new Date(Date.now() - DAY), isIdentityVerified: false }
  const { res, saved } = await putAccount({ firstName: 'Alba', lastName: 'Martin' }, fresh)
  assert.equal(res.statusCode, 200)
  assert.ok(saved)
})

test('demande de changement de nom : arrive dans les messages de l’admin', async () => {
  let message
  const res = responseRecorder()
  await withMocks({
    user: { findUnique: async () => ({ id: 10, email: 'a@b.fr', pseudo: 'ALBA', firstName: 'Alba', lastName: 'Martin', isIdentityVerified: true }) },
    contactMessage: { create: async ({ data }) => { message = data; return { id: 1 } } },
  }, () => routeHandler(profileRouter, 'post', '/me/name-change-request')({ user: { id: 10 }, body: { firstName: 'Alba', lastName: 'Durand', reason: 'Mariage' } }, res))
  assert.equal(res.statusCode, 200)
  assert.match(message.subject, /compte n°10/)
  assert.match(message.message, /Demandé : Alba Durand/)
  assert.match(message.message, /Stripe/)
})
