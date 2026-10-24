const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const searchRouter = require('../routes/search')
const { boundingBoxWhere, haversineKm } = require('../lib/geo')

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
  try { return await fn() } finally {
    for (const [model, name, original] of originals) prisma[model][name] = original
  }
}

const member = (id, extra = {}) => ({
  id,
  role: 'ARTIST',
  pseudo: `membre${id}`,
  firstName: null,
  lastName: null,
  subscription: null,
  ...extra,
  profile: { showRealName: false, specialties: ['DJ'], styles: ['House'], typeEtablissement: null, latitude: null, longitude: null, ...extra.profile },
})

// Faux Prisma : 1er appel = liste légère, 2e appel = fiches complètes de la page
function userMock(candidates, calls) {
  return {
    findMany: async args => {
      calls.push(args)
      if (args.where.id?.in) return args.where.id.in.map(id => ({ id, pseudo: `membre${id}`, role: 'ARTIST', profile: { showRealName: false } }))
      return candidates
    },
  }
}

const search = (query, mocks) => {
  const res = responseRecorder()
  return withMocks({ block: { findMany: async () => [] }, ...mocks }, async () => {
    await routeHandler(searchRouter, 'get', '/')({ user: { id: 999 }, query }, res)
    return res
  })
}

test('recherche : 24 résultats par page, avec le total et la suite', async () => {
  const calls = []
  const candidates = Array.from({ length: 30 }, (_, i) => member(i + 1))
  const res = await search({}, { user: userMock(candidates, calls) })
  assert.equal(res.body.users.length, 24)
  assert.equal(res.body.total, 30)
  assert.equal(res.body.counts.ARTIST, 30)
  assert.equal(res.body.hasMore, true)
  assert.equal(res.body.nextCursor, 24)
  // Seules les 24 fiches de la page sont chargées en entier
  assert.equal(calls[1].where.id.in.length, 24)

  const page2 = await search({ cursor: '24' }, { user: userMock(candidates, []) })
  assert.deepEqual(page2.body.users.map(u => u.id), [25, 26, 27, 28, 29, 30])
  assert.equal(page2.body.hasMore, false)
  assert.equal(page2.body.nextCursor, null)
})

test('recherche : spécialités et styles filtrés par le serveur, sans tenir compte des majuscules', async () => {
  const candidates = [
    member(1, { profile: { specialties: ['DJ'], styles: ['Techno'] } }),
    member(2, { profile: { specialties: ['Chanteur'], styles: ['House'] } }),
    member(3, { profile: { specialties: ['DJ'], styles: ['House'] } }),
    member(4, { role: 'ORGANIZER', profile: { specialties: [], styles: [], typeEtablissement: 'Club' } }),
  ]
  const res = await search({ specialties: 'dj,club', styles: 'house' }, { user: userMock(candidates, []) })
  // 1 : mauvais style ; 2 : mauvaise spécialité ; 4 : organisateur, les styles ne le concernent pas
  assert.deepEqual(res.body.users.map(u => u.id), [3, 4])
})

test('recherche : tri alphabétique sur le nom affiché', async () => {
  const candidates = [
    member(1, { pseudo: 'Zoé' }),
    member(2, { pseudo: 'alex' }),
    member(3, { pseudo: null, firstName: 'Marie', lastName: 'Durand', profile: { showRealName: true } }),
  ]
  const res = await search({ sort: 'alpha' }, { user: userMock(candidates, []) })
  assert.deepEqual(res.body.users.map(u => u.id), [2, 3, 1])
})

test('recherche : la ville seule est cherchée par la base', async () => {
  const calls = []
  await search({ zone: ' Lyon ' }, { user: userMock([], calls) })
  assert.deepEqual(calls[0].where.profile.location, { contains: 'lyon', mode: 'insensitive' })
})

test('distance : le carré de la base contient le cercle, le calcul exact écarte le reste', () => {
  const paris = { lat: 48.8566, lon: 2.3522 }
  const box = boundingBoxWhere(paris.lat, paris.lon, 100)
  // Orléans (~110 km) est hors du cercle de 100 km
  assert.ok(haversineKm(paris.lat, paris.lon, 47.9029, 1.9093) > 100)
  // Beauvais (~70 km) est dans le carré et dans le cercle
  const beauvais = { lat: 49.4295, lon: 2.0807 }
  assert.ok(beauvais.lat >= box.latitude.gte && beauvais.lat <= box.latitude.lte)
  assert.ok(beauvais.lon >= box.longitude.gte && beauvais.lon <= box.longitude.lte)
  assert.ok(haversineKm(paris.lat, paris.lon, beauvais.lat, beauvais.lon) < 100)
})
