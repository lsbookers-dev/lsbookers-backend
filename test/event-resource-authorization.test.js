const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const eventsRouter = require('../routes/events')
const documentsRouter = require('../routes/event-documents')
const staffRouter = require('../routes/event-staff')

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

function routeHandler(router, method, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method])
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} introuvable`)
  return layer.route.stack.at(-1).handle
}

const cases = [
  {
    name: 'modification dépense', router: eventsRouter, method: 'patch',
    path: '/:id/expenses/:expenseId', childParam: 'expenseId', childId: 201,
    model: 'eventExpense', mutation: 'updateMany', body: { paid: true }, responseKey: 'expense',
  },
  {
    name: 'suppression dépense', router: eventsRouter, method: 'delete',
    path: '/:id/expenses/:expenseId', childParam: 'expenseId', childId: 202,
    model: 'eventExpense', mutation: 'deleteMany', body: {},
  },
  {
    name: 'modification achat', router: eventsRouter, method: 'patch',
    path: '/:id/purchases/:purchaseId', childParam: 'purchaseId', childId: 301,
    model: 'eventPurchase', mutation: 'updateMany', body: { done: true }, responseKey: 'purchase',
  },
  {
    name: 'suppression achat', router: eventsRouter, method: 'delete',
    path: '/:id/purchases/:purchaseId', childParam: 'purchaseId', childId: 302,
    model: 'eventPurchase', mutation: 'deleteMany', body: {},
  },
  {
    name: 'suppression document', router: documentsRouter, method: 'delete',
    path: '/:id/documents/:docId', childParam: 'docId', childId: 401,
    model: 'eventDocument', mutation: 'deleteMany', body: {},
  },
  {
    name: 'suppression personnel', router: staffRouter, method: 'delete',
    path: '/:id/staff/:staffId', childParam: 'staffId', childId: 501,
    model: 'eventStaff', mutation: 'deleteMany', body: {},
  },
]

async function runCase(config, mutationCount, profileExists = true) {
  const originalProfileLookup = prisma.profile.findUnique
  const originalEventLookup = prisma.event.findFirst
  const model = prisma[config.model]
  const originalMutation = model[config.mutation]
  const originalFindUnique = model.findUnique
  let mutationWhere
  let findUniqueCalls = 0
  let eventLookupCalls = 0

  prisma.profile.findUnique = async () => profileExists ? { id: 7 } : null
  prisma.event.findFirst = async () => {
    eventLookupCalls += 1
    return { id: 100, profileId: 7 }
  }
  model[config.mutation] = async args => {
    mutationWhere = args.where
    return { count: mutationCount }
  }
  if (config.responseKey) {
    model.findUnique = async ({ where }) => {
      findUniqueCalls += 1
      return { id: where.id, eventId: 100 }
    }
  }

  const handler = routeHandler(config.router, config.method, config.path)
  const req = {
    user: { id: 9 },
    params: { id: '100', [config.childParam]: String(config.childId) },
    body: config.body,
  }
  const res = responseRecorder()

  try {
    await handler(req, res)
  } finally {
    prisma.profile.findUnique = originalProfileLookup
    prisma.event.findFirst = originalEventLookup
    model[config.mutation] = originalMutation
    if (config.responseKey) model.findUnique = originalFindUnique
  }

  return { res, mutationWhere, findUniqueCalls, eventLookupCalls }
}

for (const config of cases) {
  test(`${config.name}: autorise uniquement l’enfant du bon événement`, async () => {
    const { res, mutationWhere } = await runCase(config, 1)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(mutationWhere, { id: config.childId, eventId: 100 })
  })

  test(`${config.name}: refuse un identifiant enfant extérieur`, async () => {
    const { res, mutationWhere, findUniqueCalls } = await runCase(config, 0)
    assert.equal(res.statusCode, 404)
    assert.deepEqual(mutationWhere, { id: config.childId, eventId: 100 })
    assert.equal(findUniqueCalls, 0)
  })

  test(`${config.name}: refuse un compte sans profil avant toute recherche d’événement`, async () => {
    const { res, mutationWhere, eventLookupCalls } = await runCase(config, 1, false)
    assert.equal(res.statusCode, 404)
    assert.equal(mutationWhere, undefined)
    assert.equal(eventLookupCalls, 0)
  })
}

test('ajouter un membre ne modifie pas sa disponibilité sans consentement', async () => {
  const originals = {
    profileLookup: prisma.profile.findUnique,
    eventLookup: prisma.event.findFirst,
    staffCreate: prisma.eventStaff.create,
    availabilityUpsert: prisma.availability.upsert,
  }
  let availabilityCalls = 0
  prisma.profile.findUnique = async () => ({ id: 7 })
  prisma.event.findFirst = async () => ({ id: 100, profileId: 7, start: new Date() })
  prisma.eventStaff.create = async () => ({ id: 501, eventId: 100, profileId: 88 })
  prisma.availability.upsert = async () => { availabilityCalls += 1; return {} }

  const handler = routeHandler(staffRouter, 'post', '/:id/staff')
  const req = {
    user: { id: 9 },
    params: { id: '100' },
    body: { role: 'Technicien', profileId: '88' },
  }
  const res = responseRecorder()

  try {
    await handler(req, res)
  } finally {
    prisma.profile.findUnique = originals.profileLookup
    prisma.event.findFirst = originals.eventLookup
    prisma.eventStaff.create = originals.staffCreate
    prisma.availability.upsert = originals.availabilityUpsert
  }

  assert.equal(res.statusCode, 201)
  assert.equal(availabilityCalls, 0)
})
