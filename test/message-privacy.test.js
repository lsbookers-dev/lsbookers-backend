const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const messageRouter = require('../routes/message')

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

/* Fiche User complète telle qu'en base : ne doit jamais sortir de l'API */
const FULL_SENDER = {
  id: 9,
  pseudo: 'alice',
  firstName: 'Alice',
  lastName: 'Martin',
  email: 'alice@example.com',
  password: '$2b$10$hashhashhash',
  phone: '0600000000',
  birthDate: new Date('1990-01-01'),
  emailVerificationToken: 'secret-token',
  role: 'ARTIST',
  profile: { id: 3, avatar: 'https://pub-x.r2.dev/lsbookers/avatars/a.jpg', bio: 'x' },
}

/* Reproduit le comportement de Prisma : include true → tout, select → seulement les champs demandés */
function applyInclude(full, spec) {
  if (spec === true) return full
  if (spec?.select) {
    const out = {}
    for (const [key, sub] of Object.entries(spec.select)) {
      if (!sub) continue
      out[key] = sub === true ? full[key] : applyInclude(full[key], sub)
    }
    return out
  }
  if (spec?.include) return full
  return full
}

const SENSITIVE = ['email', 'password', 'phone', 'birthDate', 'emailVerificationToken']

function assertNoSensitiveData(body) {
  const json = JSON.stringify(body)
  for (const value of [FULL_SENDER.email, FULL_SENDER.password, FULL_SENDER.phone, FULL_SENDER.emailVerificationToken]) {
    assert.ok(!json.includes(value), `Donnée sensible exposée : ${value}`)
  }
  for (const key of SENSITIVE) {
    assert.ok(!json.includes(`"${key}"`), `Champ sensible exposé : ${key}`)
  }
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

function baseMocks({ blocked = false } = {}) {
  return {
    conversationParticipant: {
      findFirst: async () => ({ id: 1 }),
      findMany: async () => [{ userId: 9 }, { userId: 12 }].filter(Boolean),
    },
    block: { findFirst: async () => (blocked ? { id: 77 } : null) },
    conversation: {
      findFirst: async () => ({ id: 50 }),
      create: async () => ({ id: 50 }),
      update: async () => ({}),
    },
    message: {
      create: async ({ data, include }) => ({
        id: 1000, ...data, seen: false, createdAt: new Date(),
        sender: applyInclude(FULL_SENDER, include.sender),
      }),
    },
    notification: { create: async () => ({}) },
  }
}

test('share-profile : la réponse ne contient aucune donnée privée de l\'expéditeur', async () => {
  const mocks = baseMocks()
  mocks.user = {
    findUnique: async () => ({
      id: 12, pseudo: 'bob', firstName: 'Bob', lastName: 'D', role: 'ORGANIZER',
      profile: { id: 4, avatar: null, profession: null, location: 'Paris' },
    }),
  }
  const res = responseRecorder()
  await withMocks(mocks, () => routeHandler(messageRouter, 'post', '/share-profile')(
    { user: { id: 9 }, body: { conversationId: 50, profileUserId: 12 } }, res,
  ))
  assert.equal(res.statusCode, 200)
  assertNoSensitiveData(res.body)
  assert.deepEqual(res.body.sender, { id: 9, name: 'alice', image: FULL_SENDER.profile.avatar })
  assert.equal(res.body.type, 'PROFILE_SHARE')
})

test('share-offer : la réponse ne contient aucune donnée privée de l\'expéditeur', async () => {
  const mocks = baseMocks()
  mocks.user = { findUnique: async () => ({ id: 12, role: 'ARTIST' }) }
  mocks.offer = {
    findUnique: async () => ({
      id: 5, title: 'Soirée', description: 'd', type: 'GIG', location: 'Lyon', country: 'FR',
      date: new Date(), status: 'OPEN', createdAt: new Date(), _count: { applications: 0 },
      organizer: { id: 3, avatar: null, user: { id: 9, pseudo: 'alice' } },
    }),
  }
  const res = responseRecorder()
  await withMocks(mocks, () => routeHandler(messageRouter, 'post', '/share-offer')(
    { user: { id: 9 }, body: { recipientId: 12, offerId: 5 } }, res,
  ))
  assert.equal(res.statusCode, 200)
  assertNoSensitiveData(res.body)
  assert.equal(res.body.message.type, 'OFFER_SHARE')
})

test('send : la réponse ne contient aucune donnée privée de l\'expéditeur', async () => {
  const mocks = baseMocks()
  mocks.user = { findUnique: async () => ({ id: 12, role: 'ARTIST' }) }
  const res = responseRecorder()
  await withMocks(mocks, () => routeHandler(messageRouter, 'post', '/send')(
    { user: { id: 9 }, body: { recipientId: 12, content: 'Salut' } }, res,
  ))
  assert.equal(res.statusCode, 200)
  assertNoSensitiveData(res.body)
})

for (const [path, body, userMock] of [
  ['/start', { recipientId: 12 }, { id: 12, role: 'ARTIST' }],
  ['/send', { recipientId: 12, content: 'Salut' }, { id: 12, role: 'ARTIST' }],
  ['/share-offer', { recipientId: 12, offerId: 5 }, { id: 12, role: 'ARTIST' }],
  ['/share-profile', { conversationId: 50, profileUserId: 30 }, { id: 30, role: 'ARTIST' }],
]) {
  test(`${path} : refusé si un blocage existe entre les deux utilisateurs`, async () => {
    const mocks = baseMocks({ blocked: true })
    let created = false
    mocks.user = { findUnique: async () => userMock }
    mocks.message.create = async () => { created = true; return {} }
    const res = responseRecorder()
    await withMocks(mocks, () => routeHandler(messageRouter, 'post', path)({ user: { id: 9 }, body }, res))
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.error, 'BLOCKED')
    assert.equal(created, false)
  })
}
