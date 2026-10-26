const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const invoicesRouter = require('../routes/invoices')
const reviewsRouter = require('../routes/reviews')
const checklistsRouter = require('../routes/checklists')
const { artistPrestations } = require('../services/prestations')
const { parisClock } = require('../services/weeklyRecap')

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

// Comptes normaux : ni formule Agence, ni profil géré par une agence
const NO_AGENCY = {
  agencySubscription: { findUnique: async () => null },
  profileManager: { findMany: async () => [] },
}

async function withMocks(mocks, fn) {
  mocks = { ...mocks }
  for (const [model, methods] of Object.entries(NO_AGENCY)) mocks[model] = { ...methods, ...mocks[model] }
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

const ME = { id: 1 }

test('facture : numéro suivant calculé sur le plus grand numéro (après 999 aussi)', async () => {
  let created
  const res = responseRecorder()
  await withMocks({
    profile: { findUnique: async () => ME },
    invoice: {
      findMany: async () => [{ number: 'F-2026-009' }, { number: 'F-2026-010' }, { number: 'F-2026-002' }],
      create: async ({ data }) => { created = data; return { ...data, id: 5, items: data.items, issuer: null, client: null } },
    },
  }, () => routeHandler(invoicesRouter, 'post', '/')({
    user: { id: 10 },
    body: { kind: 'INVOICE', clientName: 'Club Nova', items: [{ label: 'DJ set', quantity: 1, unitPrice: 400 }], issueDate: '2026-10-14' },
  }, res))
  assert.equal(res.statusCode, 201)
  assert.equal(created.number, 'F-2026-011')
  assert.equal(res.body.invoice.totals.ttc, 400)
})

test('facture envoyée : plus modifiable', async () => {
  const res = responseRecorder()
  await withMocks({
    profile: { findUnique: async () => ME },
    invoice: { findUnique: async () => ({ issuerId: 1, status: 'SENT', kind: 'INVOICE' }) },
  }, () => routeHandler(invoicesRouter, 'put', '/:id')({
    user: { id: 10 }, params: { id: '5' },
    body: { kind: 'INVOICE', clientName: 'X', items: [{ label: 'A', quantity: 1, unitPrice: 1 }] },
  }, res))
  assert.equal(res.statusCode, 409)
})

test('avis : une seule réponse, et seulement par la personne notée', async () => {
  const call = async (review, profile = { id: 2, user: { id: 20 } }) => {
    const res = responseRecorder()
    let updated = false
    await withMocks({
      profile: { findUnique: async () => profile },
      review: {
        findUnique: async () => review,
        updateMany: async () => { updated = true; return { count: 1 } },
      },
      notification: { create: async () => ({}) },
    }, () => routeHandler(reviewsRouter, 'post', '/:id/reply')({ user: { id: 20 }, params: { id: '9' }, body: { reply: 'Merci !' } }, res))
    return { res, updated }
  }
  const first = await call({ id: 9, targetId: 2, reply: null, author: { user: { id: 30 } } })
  assert.equal(first.res.statusCode, 200)
  assert.ok(first.updated)
  const again = await call({ id: 9, targetId: 2, reply: 'Déjà', author: { user: { id: 30 } } })
  assert.equal(again.res.statusCode, 409)
  const stranger = await call({ id: 9, targetId: 3, reply: null, author: { user: { id: 30 } } })
  assert.equal(stranger.res.statusCode, 404)
})

test('checklist : refusée à qui n’est ni organisateur ni booké sur l’événement', async () => {
  const res = responseRecorder()
  await withMocks({
    profile: { findUnique: async () => ({ id: 7 }) },
    event: { findUnique: async () => ({ id: 3, profileId: 1 }) },
    eventStaff: { findFirst: async () => null },
  }, () => routeHandler(checklistsRouter, 'get', '/:id/checklist')({ user: { id: 70 }, params: { id: '3' } }, res))
  assert.equal(res.statusCode, 403)
})

test('revenus : un booking et sa place staff sur le même événement comptent une fois', async () => {
  const past = new Date(Date.now() - 864e5)
  const org = { id: 1, avatar: null, showRealName: false, user: { id: 10, pseudo: 'Club', role: 'ORGANIZER' } }
  const items = await withMocks({
    bookingRequest: { findMany: async () => [{ id: 4, eventId: 9, startDate: past, fee: null, requester: org, event: { id: 9, title: 'Soirée', lieu: 'Lyon', status: 'PUBLISHED' } }] },
    eventStaff: { findMany: async () => [{ id: 5, eventId: 9, fee: 350, event: { id: 9, title: 'Soirée', lieu: 'Lyon', start: past, profile: org } }] },
  }, () => artistPrestations(2))
  assert.equal(items.length, 1)
  assert.equal(items[0].amount, 350)
  assert.equal(items[0].counterpart.name, 'Club')
})

test('récap : lundi 8 h à Paris reconnu malgré le décalage horaire', () => {
  const clock = parisClock(new Date('2026-10-19T06:30:00Z')) // lundi 8 h 30 à Paris (heure d'été)
  assert.equal(clock.weekday, 'Mon')
  assert.equal(clock.hour, 8)
})

test('profil public : l’adresse n’apparaît que si l’organisateur l’a choisi', async () => {
  const profileRouter = require('../routes/profile')
  const base = {
    id: 3, userId: 30, address: '12 rue de la Paix', postalCode: '69001', city: 'Lyon', showRealName: false,
    user: { id: 30, pseudo: 'Club', firstName: 'A', lastName: 'B', role: 'ORGANIZER', _count: { followers: 0, following: 0 } },
  }
  const get = async (showAddress) => {
    const res = responseRecorder()
    await withMocks({
      profile: { findUnique: async () => ({ ...base, showAddress }) },
      review: { aggregate: async () => ({ _avg: { rating: null }, _count: { rating: 0 } }) },
    }, () => routeHandler(profileRouter, 'get', '/user/:userId')({ params: { userId: '30' }, user: null }, res))
    return res.body.profile
  }
  const hidden = await get(false)
  assert.equal(hidden.address, undefined)
  assert.equal(hidden.postalCode, undefined)
  const shown = await get(true)
  assert.equal(shown.address, '12 rue de la Paix')
})

test('Mon espace : opportunités filtrées par la base (rôle, spécialités) et limitées à 3', async () => {
  const spaceRouter = require('../routes/space')
  let args
  const res = responseRecorder()
  await withMocks({
    profile: { findUnique: async () => ({ id: 2, specialties: ['DJ'], user: { role: 'ARTIST' } }) },
    offer: {
      count: async () => 7,
      findMany: async (a) => { args = a; return [{ id: 1, title: 'Soirée', organizer: { id: 1, showRealName: false, user: { pseudo: 'Club' } } }] },
    },
  }, () => routeHandler(spaceRouter, 'get', '/opportunities')({ user: { id: 20 } }, res))
  assert.equal(res.body.total, 7)
  assert.equal(args.take, 3)
  assert.deepEqual(args.where.type, { in: ['ARTIST', 'ALL'] })
  assert.equal(res.body.offers[0].organizer.name, 'Club')
})

test('notifications : jamais toute la liste d’un coup', async () => {
  const notificationsRouter = require('../routes/notifications')
  let take
  await withMocks({
    notification: { findMany: async (a) => { take = a.take; return [] } },
  }, () => routeHandler(notificationsRouter, 'get', '/')({ user: { id: 1 }, query: { limit: '5000' } }, responseRecorder()))
  assert.equal(take, 201) // 200 au plus + 1 pour savoir s'il en reste
})
