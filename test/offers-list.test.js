const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const offersRouter = require('../routes/offers')

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

const offer = id => ({
  id, title: `Offre ${id}`, description: '', type: 'ARTIST', specialty: null, date: new Date(), location: 'Lyon', country: 'France',
  status: 'ACTIVE', createdAt: new Date(), organizer: { id: 1, userId: 1, user: { pseudo: 'Orga' } }, event: null, _count: { applications: 0 },
})

async function listOffers(query, total = 45) {
  const all = Array.from({ length: total }, (_, i) => offer(total - i))
  const calls = []
  const originals = { findMany: prisma.offer.findMany, count: prisma.offer.count }
  prisma.offer.findMany = async args => { calls.push(args); return all.slice(args.skip, args.skip + args.take) }
  prisma.offer.count = async () => total
  try {
    const res = responseRecorder()
    await routeHandler(offersRouter, 'get', '/')({ query }, res)
    return { res, calls }
  } finally {
    Object.assign(prisma.offer, originals)
  }
}

test('offres : page Opportunités par paquets de 20, avec le total', async () => {
  const { res, calls } = await listOffers({ paged: '1' })
  assert.equal(res.body.offers.length, 20)
  assert.equal(res.body.total, 45)
  assert.equal(res.body.nextCursor, 20)
  assert.equal(calls[0].take, 20)

  const last = await listOffers({ paged: '1', cursor: '40' })
  assert.equal(last.res.body.offers.length, 5)
  assert.equal(last.res.body.hasMore, false)
  assert.equal(last.res.body.nextCursor, null)
})

test('offres : sans « paged », un tableau plafonné (encart de l\'accueil)', async () => {
  const six = await listOffers({ limit: '6' })
  assert.ok(Array.isArray(six.res.body))
  assert.equal(six.res.body.length, 6)
  const capped = await listOffers({ limit: '500' }, 80)
  assert.equal(capped.calls[0].take, 50)
})

test('offres : « Pour moi » filtré par le serveur (rôle + spécialités)', async () => {
  const { calls } = await listOffers({ paged: '1', forRole: 'ARTIST', forSpecialties: 'DJ,Chanteur' })
  const and = calls[0].where.AND
  assert.deepEqual(and[1], { type: { in: ['ARTIST', 'ALL'] } })
  assert.deepEqual(and[2].OR.slice(2), [
    { specialty: { equals: 'DJ', mode: 'insensitive' } },
    { specialty: { equals: 'Chanteur', mode: 'insensitive' } },
  ])
})
