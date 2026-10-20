const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const homeRouter = require('../routes/home')
const profileRouter = require('../routes/profile')

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    end() { return this },
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

// ── Petite base en mémoire pour le fil ──────────────────────
// Profil 1 = moi, profil 2 = suivi, profils 3 à 6 = autres membres
const HOUR = 3_600_000
const NOW = Date.now()
const PUBS = Array.from({ length: 60 }, (_, i) => ({
  id: i + 1,
  profileId: [1, 2, 2, 3, 4, 5, 6][i % 7],
  createdAt: new Date(NOW - (i * 7 + (i % 3)) * HOUR),
  title: `p${i + 1}`, media: 'x', mediaType: 'IMAGE', caption: null,
  _count: { likes: (i * 7) % 11, comments: i % 4 },
  additionalMedia: [], tags: [],
  profile: { avatar: null, user: { id: 100, role: 'ARTIST', pseudo: 'u' } },
}))

function matches(pub, where = {}) {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') { if (!cond.some(c => matches(pub, c))) return false; continue }
    if (key === 'AND') { if (!cond.every(c => matches(pub, c))) return false; continue }
    // Filtre sur l'auteur (compte en pause) : aucun auteur en pause dans ces données
    if (key === 'profile') continue
    const value = pub[key]
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if (cond.in && !cond.in.includes(value)) return false
      if (cond.notIn && cond.notIn.includes(value)) return false
      if (cond.lt !== undefined && !(value < cond.lt)) return false
      if (cond.gte !== undefined && !(value >= cond.gte)) return false
    } else if (cond instanceof Date) {
      if (value.getTime() !== cond.getTime()) return false
    } else if (value !== cond) return false
  }
  return true
}

const publicationMock = {
  findMany: async ({ where, orderBy, take }) => {
    let rows = PUBS.filter(p => matches(p, where))
    if (orderBy) rows.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
    if (take) rows = rows.slice(0, take)
    return structuredClone(rows)
  },
}

function feedMocks(followCount) {
  return {
    profile: {
      findUnique: async () => ({ id: 1, userId: 1 }),
      findMany: async () => [{ id: 2 }],
    },
    follow: { findMany: async () => Array.from({ length: followCount }, (_, i) => ({ followingId: 2 + i })) },
    block: { findMany: async () => [] },
    publication: publicationMock,
    publicationLike: { findMany: async () => [] },
    adminPost: { findMany: async () => [] },
  }
}

async function readWholeFeed(followCount) {
  const seen = []
  let cursor
  let pages = 0
  do {
    const res = responseRecorder()
    await withMocks(feedMocks(followCount), () =>
      routeHandler(homeRouter, 'get', '/feed')({ user: { id: 1 }, query: cursor ? { cursor } : {} }, res))
    assert.equal(res.statusCode, 200)
    seen.push(...res.body.posts.map(p => p.id))
    cursor = res.body.nextCursor
    pages++
  } while (cursor && pages < 20)
  return { seen, pages }
}

test('fil « Pour vous » : en descendant, aucune publication répétée ni sautée', async () => {
  const { seen, pages } = await readWholeFeed(1)
  assert.ok(pages > 1, 'le fil doit tenir sur plusieurs pages')
  assert.equal(new Set(seen).size, seen.length, 'publication répétée')
  // Tout ce qui est récent (≤ 90 j) ou suivi doit apparaître
  const expected = PUBS.filter(p => [1, 2].includes(p.profileId) || p.createdAt >= new Date(NOW - 90 * 24 * HOUR)).map(p => p.id)
  assert.deepEqual([...seen].sort((a, b) => a - b), expected.sort((a, b) => a - b))
})

test('fil « Pour vous » : curseur illisible refusé', async () => {
  const res = responseRecorder()
  await withMocks(feedMocks(0), () =>
    routeHandler(homeRouter, 'get', '/feed')({ user: { id: 1 }, query: { cursor: '%%%' } }, res))
  assert.equal(res.statusCode, 400)
})

// ── À proximité ─────────────────────────────────────────────
const MARSEILLE = { latitude: 43.2964, longitude: 5.3778 }
const AIX = { latitude: 43.5297, longitude: 5.4474 }
const LYON = { latitude: 45.7578, longitude: 4.832 }

test('à proximité : membres à moins de 100 km, ou même ville quand il manque les coordonnées', async () => {
  let asked
  const res = responseRecorder()
  await withMocks({
    profile: {
      findUnique: async () => ({ id: 1, ...MARSEILLE, city: 'Marseille', location: 'Marseille' }),
      findMany: async () => [
        { id: 2, ...AIX },
        { id: 3, ...LYON },
        { id: 4, latitude: null, longitude: null, city: 'marseille', location: null },
        { id: 5, latitude: null, longitude: null, city: 'Paris', location: null },
      ],
    },
    block: { findMany: async () => [] },
    publication: { findMany: async (a) => { asked = a; return [] } },
    publicationLike: { findMany: async () => [] },
  }, () => routeHandler(homeRouter, 'get', '/nearby')({ user: { id: 1 }, query: {} }, res))
  assert.deepEqual(asked.where.profileId.in, [2, 4])
  assert.equal(res.body.region, 'Marseille')
})

test('à proximité : sans ville dans le profil, on invite à la renseigner', async () => {
  const res = responseRecorder()
  await withMocks({
    profile: { findUnique: async () => ({ id: 1, latitude: null, longitude: null, city: null, location: null }) },
    block: { findMany: async () => [] },
  }, () => routeHandler(homeRouter, 'get', '/nearby')({ user: { id: 1 }, query: {} }, res))
  assert.equal(res.body.needsLocation, true)
  assert.deepEqual(res.body.posts, [])
})

// ── Tendances ───────────────────────────────────────────────
const trendProfile = (id, specialties) => ({
  id, avatar: null, specialties, profession: null, location: 'Marseille', city: null,
  user: { id: 100 + id, pseudo: `p${id}`, role: 'ARTIST' },
})

test('tendances : un seul classement, tous les critères mélangés en points', async () => {
  const res = responseRecorder()
  await withMocks({
    // Profil 1 : 1 booking (10) + 1 recherche (3) = 13 ; profil 2 : 9 visites + 2 J'aime = 11 ; profil 3 (DJ) : 4 recherches = 12
    profileSearchHit: { groupBy: async () => [{ profileId: 1, _count: { _all: 1 } }, { profileId: 3, _count: { _all: 4 } }] },
    profileView: { groupBy: async () => [{ profileId: 2, _count: { _all: 9 } }] },
    bookingRequest: { groupBy: async (a) => {
      assert.deepEqual(a.where.status, { in: ['ACCEPTED', 'COMPLETED'] })
      return [{ targetId: 1, _count: { _all: 1 } }]
    } },
    profile: { findMany: async () => [trendProfile(1, ['DJ']), trendProfile(2, ['Chanteur']), trendProfile(3, ['DJ'])] },
  }, async () => {
    const original = prisma.$queryRaw
    prisma.$queryRaw = async () => [{ profileId: 2, count: 2 }]
    try {
      await routeHandler(homeRouter, 'get', '/trends')({ query: {} }, res)
    } finally { prisma.$queryRaw = original }
  })
  assert.deepEqual(res.body.items.map(i => [i.profileId, i.score]), [[1, 13], [3, 12], [2, 11]])
  assert.deepEqual(res.body.specialties, ['DJ', 'Chanteur'])
  assert.equal(res.body.periodDays, 30)
})

test('tendances : filtre par spécialité (fenêtre « Voir plus »)', async () => {
  const res = responseRecorder()
  await withMocks({
    profileSearchHit: { groupBy: async () => [] },
    profileView: { groupBy: async () => [{ profileId: 1, _count: { _all: 3 } }, { profileId: 2, _count: { _all: 9 } }] },
    bookingRequest: { groupBy: async () => [] },
    profile: { findMany: async () => [trendProfile(1, ['DJ']), trendProfile(2, ['Chanteur'])] },
  }, async () => {
    const original = prisma.$queryRaw
    prisma.$queryRaw = async () => []
    try {
      await routeHandler(homeRouter, 'get', '/trends')({ query: { specialty: 'DJ' } }, res)
    } finally { prisma.$queryRaw = original }
  })
  assert.deepEqual(res.body.items.map(i => i.profileId), [1])
})

// ── Recherche ───────────────────────────────────────────────
test('profil ouvert depuis la recherche : compté, sauf son propre profil', async () => {
  let created = 0
  const mocks = {
    profile: { findUnique: async () => ({ id: 7 }) },
    profileSearchHit: { upsert: async () => { created++ } },
  }
  const handler = routeHandler(profileRouter, 'post', '/user/:userId/search-hit')
  await withMocks(mocks, () => handler({ params: { userId: '5' }, user: { id: 1 } }, responseRecorder()))
  await withMocks(mocks, () => handler({ params: { userId: '1' }, user: { id: 1 } }, responseRecorder()))
  assert.equal(created, 1)
})
