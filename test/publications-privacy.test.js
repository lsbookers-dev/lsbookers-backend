const test = require('node:test')
const assert = require('node:assert/strict')

process.env.R2_PUBLIC_URL = 'https://pub-test.r2.dev'

const prisma = require('../prisma/client')
const publicationsRouter = require('../routes/publications')
const { isOwnMediaUrl } = require('../lib/mediaUrl')

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

const tag = (id, status, userId) => ({ id, status, taggedUser: { id: userId, pseudo: `u${userId}` } })
const PUB = {
  id: 1, media: 'https://pub-test.r2.dev/lsbookers/media/a.jpg', additionalMedia: [],
  profile: { userId: 10 },
  tags: [tag(1, 'ACCEPTED', 20), tag(2, 'PENDING', 21), tag(3, 'DECLINED', 22)],
  _count: { likes: 0, comments: 0 },
}

async function getPublication(user, blocked = false) {
  const res = responseRecorder()
  await withMocks({
    publication: { findUnique: async () => structuredClone(PUB) },
    block: { findFirst: async () => (blocked ? { id: 1 } : null) },
  }, () => routeHandler(publicationsRouter, 'get', '/:id(\\d+)')({ params: { id: '1' }, user }, res))
  return res
}

test('publication publique : seules les identifications acceptées sont visibles', async () => {
  const res = await getPublication(undefined)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.tags.map(t => t.status), ['ACCEPTED'])
  assert.equal(res.body.profile, undefined)
})

test('publication : l\'auteur voit toutes ses identifications', async () => {
  const res = await getPublication({ id: 10 })
  assert.equal(res.body.tags.length, 3)
})

test('publication : la personne identifiée voit sa propre identification en attente', async () => {
  const res = await getPublication({ id: 21 })
  assert.deepEqual(res.body.tags.map(t => t.id), [1, 2])
})

test('publication : invisible si un blocage existe avec l\'auteur', async () => {
  const res = await getPublication({ id: 99 }, true)
  assert.equal(res.statusCode, 404)
})

test('like refusé si un blocage existe avec l\'auteur', async () => {
  const res = responseRecorder()
  let created = false
  await withMocks({
    profile: { findUnique: async () => ({ id: 5 }) },
    publicationLike: { findUnique: async () => null, create: async () => { created = true } },
    publication: { findUnique: async () => ({ profile: { userId: 10 } }) },
    block: { findFirst: async () => ({ id: 1 }) },
  }, () => routeHandler(publicationsRouter, 'post', '/:id/like')({ params: { id: '1' }, user: { id: 99 } }, res))
  assert.equal(res.statusCode, 403)
  assert.equal(created, false)
})

test('commentaire refusé si un blocage existe avec l\'auteur', async () => {
  const res = responseRecorder()
  let created = false
  await withMocks({
    profile: { findUnique: async () => ({ id: 5 }) },
    publication: { findUnique: async () => ({ profile: { userId: 10 } }) },
    publicationComment: { create: async () => { created = true } },
    block: { findFirst: async () => ({ id: 1 }) },
  }, () => routeHandler(publicationsRouter, 'post', '/:id/comments')(
    { params: { id: '1' }, user: { id: 99 }, body: { content: 'x' } }, res))
  assert.equal(res.statusCode, 403)
  assert.equal(created, false)
})

test('publication refusée si le média ne vient pas de notre stockage', async () => {
  for (const media of ['https://evil.com/a.jpg', 'https://pub-test.r2.dev.evil.com/a.jpg']) {
    const res = responseRecorder()
    await withMocks({
      profile: { findUnique: async () => ({ id: 5, userId: 99 }) },
    }, () => routeHandler(publicationsRouter, 'post', '/')(
      { user: { id: 99 }, body: { title: 't', media, profileId: 5 } }, res))
    assert.equal(res.statusCode, 400, media)
  }
})

test('isOwnMediaUrl : R2 et Vercel Blob acceptés, le reste refusé', () => {
  assert.equal(isOwnMediaUrl('https://pub-test.r2.dev/lsbookers/a.jpg'), true)
  assert.equal(isOwnMediaUrl('https://abc.public.blob.vercel-storage.com/a.png'), true)
  assert.equal(isOwnMediaUrl('https://pub-test.r2.dev.evil.com/a.jpg'), false)
  assert.equal(isOwnMediaUrl('http://abc.public.blob.vercel-storage.com/a.png'), false)
  assert.equal(isOwnMediaUrl('javascript:alert(1)'), false)
  assert.equal(isOwnMediaUrl('https://evil.com/a.jpg'), false)
})
