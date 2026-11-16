process.env.LSB_DISABLE_EMAILS = '1'

const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const { clearPlanSettingsCache } = require('../lib/planSettings')
const { createReport, resolveReports, ModerationError } = require('../services/moderation')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const { matchAction } = require('../lib/adminAudit')
const publicationsRouter = require('../routes/publications')

async function withMocks(mocks, fn) {
  const originals = []
  for (const [model, methods] of Object.entries(mocks)) {
    for (const [name, impl] of Object.entries(methods)) {
      originals.push([model, name, prisma[model][name]])
      prisma[model][name] = impl
    }
  }
  clearPlanSettingsCache()
  try { return await fn() } finally {
    for (const [model, name, original] of originals) prisma[model][name] = original
  }
}

const PUB = { title: 'Booking garanti', caption: 'Envoyez un acompte', media: 'https://ailleurs.test/a.jpg', mediaType: 'image', additionalMedia: [], profile: { userId: 10 } }

/** Base factice : une publication du membre 10, `pending` signalements déjà en attente */
function world({ pending = 0, existing = null, today = 0 } = {}) {
  const calls = { created: [], hidden: [], notifs: [], reportUpdates: [], deleted: [], userUpdates: [] }
  const mocks = {
    publication: {
      findUnique: async () => structuredClone(PUB),
      updateMany: async ({ data }) => { calls.hidden.push(data.hiddenAt); return { count: 1 } },
      delete: async ({ where }) => { calls.deleted.push(where.id); return {} },
    },
    report: {
      findFirst: async () => existing,
      count: async ({ where }) => (where.reporterId ? today : pending + calls.created.length),
      create: async ({ data }) => { calls.created.push(data); return { id: 1, ...data } },
      findMany: async () => [
        { id: 1, reporterId: 21, targetUserId: 10, reason: 'SCAM', snapshot: { title: 'Booking garanti' } },
        { id: 2, reporterId: 22, targetUserId: 10, reason: 'SCAM', snapshot: { title: 'Booking garanti' } },
      ],
      updateMany: async ({ data }) => { calls.reportUpdates.push(data); return { count: 2 } },
    },
    adminSettings: { findUnique: async () => null },
    user: {
      findMany: async () => [{ id: 1, email: 'admin@test.fr' }],
      findUnique: async ({ where }) => ({ id: where.id, email: `u${where.id}@test.fr`, pseudo: `Membre${where.id}`, role: 'ARTIST', notifPrefs: null }),
      update: async ({ where, data }) => { calls.userUpdates.push({ id: where.id, data }); return {} },
    },
    notification: {
      findFirst: async () => null,
      create: async ({ data }) => { calls.notifs.push(data); return { id: calls.notifs.length } },
    },
  }
  return { calls, mocks }
}

const report = (extra = {}) => createReport({ reporterId: 20, targetType: 'PUBLICATION', targetId: 5, reason: 'SCAM', details: '', ...extra })

test('signalement : enregistré avec une copie du contenu, admin prévenu au premier', async () => {
  const { calls, mocks } = world()
  const res = await withMocks(mocks, () => report())
  assert.deepEqual(res, { ok: true, already: false, author: { id: 10, name: 'Membre10' } })
  assert.equal(calls.created[0].targetUserId, 10)
  assert.equal(calls.created[0].snapshot.title, 'Booking garanti')
  assert.equal(calls.hidden.length, 0, 'un seul signalement ne masque rien')
  assert.equal(calls.notifs.length, 1)
  assert.equal(calls.notifs[0].type, 'ADMIN_REPORT')
})

test('signalement : impossible sur son propre contenu', async () => {
  const { calls, mocks } = world()
  await assert.rejects(withMocks(mocks, () => report({ reporterId: 10 })), (e) => e instanceof ModerationError && e.code === 'SELF')
  assert.equal(calls.created.length, 0)
})

test('signalement : un seul par membre et par contenu', async () => {
  const { calls, mocks } = world({ existing: { id: 9 } })
  const res = await withMocks(mocks, () => report())
  assert.equal(res.already, true)
  assert.equal(calls.created.length, 0)
})

test('signalement : 10 par jour au maximum', async () => {
  const { calls, mocks } = world({ today: 10 })
  await assert.rejects(withMocks(mocks, () => report()), (e) => e.status === 429)
  assert.equal(calls.created.length, 0)
})

test('signalement : motif inconnu ou « Autre » sans explication refusés', async () => {
  const { mocks } = world()
  await assert.rejects(withMocks(mocks, () => report({ reason: 'NIMPORTE' })), (e) => e.code === 'REASON')
  await assert.rejects(withMocks(mocks, () => report({ reason: 'OTHER', details: '  ' })), (e) => e.code === 'DETAILS')
})

test('signalement : au 3e membre, la publication est masquée et l’admin prévenu', async () => {
  const { calls, mocks } = world({ pending: 2 })
  await withMocks(mocks, () => report())
  assert.equal(calls.hidden.length, 1)
  assert.ok(calls.hidden[0] instanceof Date)
  assert.match(calls.notifs[0].content, /masquée en attendant/)
})

test('signalement : le 2e ne masque rien et ne re-prévient pas l’admin', async () => {
  const { calls, mocks } = world({ pending: 1 })
  await withMocks(mocks, () => report())
  assert.equal(calls.hidden.length, 0)
  assert.equal(calls.notifs.length, 0)
})

test('décision « retirer » : contenu supprimé, auteur prévenu sans le nom des signaleurs, signaleurs remerciés', async () => {
  const { calls, mocks } = world()
  const res = await withMocks(mocks, () => resolveReports({ adminId: 1, targetType: 'PUBLICATION', targetId: 5, action: 'REMOVE', warn: true }))
  assert.equal(res.status, 'REMOVED')
  assert.deepEqual(calls.deleted, [5])
  assert.equal(calls.reportUpdates[0].status, 'REMOVED')
  assert.deepEqual(calls.userUpdates, [{ id: 10, data: { warningCount: { increment: 1 } } }])
  const toAuthor = calls.notifs.find(n => n.userId === 10)
  assert.equal(toAuthor.type, 'MODERATION_NOTICE')
  assert.match(toAuthor.content, /Votre publication « Booking garanti » a été retirée/)
  assert.match(toAuthor.content, /arnaque ou fraude/)
  assert.doesNotMatch(toAuthor.content, /Membre21|Membre22/)
  assert.deepEqual(calls.notifs.filter(n => n.type === 'REPORT_RESOLVED').map(n => n.userId).sort(), [21, 22])
})

test('décision « sans suite » : contenu rétabli, auteur jamais prévenu', async () => {
  const { calls, mocks } = world()
  await withMocks(mocks, () => resolveReports({ adminId: 1, targetType: 'PUBLICATION', targetId: 5, action: 'DISMISS' }))
  assert.deepEqual(calls.hidden, [null])
  assert.equal(calls.deleted.length, 0)
  assert.equal(calls.notifs.some(n => n.userId === 10), false)
})

test('décision « suspendre » : compte suspendu et déconnecté partout', async () => {
  const { calls, mocks } = world()
  const res = await withMocks(mocks, () => resolveReports({ adminId: 1, targetType: 'PUBLICATION', targetId: 5, action: 'BAN' }))
  assert.equal(res.status, 'BANNED')
  assert.ok(calls.userUpdates[0].data.bannedAt instanceof Date)
  assert.deepEqual(calls.userUpdates[0].data.tokenVersion, { increment: 1 })
})

test('décision : un profil ne se « retire » pas', async () => {
  const { mocks } = world()
  await assert.rejects(withMocks(mocks, () => resolveReports({ adminId: 1, targetType: 'PROFILE', targetId: 10, action: 'REMOVE' })), (e) => e.status === 400)
})

test('admin : les routes de signalement sont réservées à l’admin et journalisées par la route', () => {
  const router = require('../routes/adminReports')
  assert.equal(router.stack[0].handle, requireAuth)
  assert.equal(router.stack[1].handle, requireAdmin)
  assert.equal(matchAction('POST', '/reports/resolve'), null)
})

test('publication masquée : introuvable pour les autres, visible pour son auteur', async () => {
  const layer = publicationsRouter.stack.find(item => item.route?.path === '/:id(\\d+)' && item.route.methods.get)
  const handler = layer.route.stack.at(-1).handle
  const run = async (user) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { this.body = b; return this } }
    await withMocks({
      publication: { findUnique: async () => ({ id: 1, hiddenAt: new Date(), tags: [], profile: { userId: 10, user: { bannedAt: null } } }) },
      block: { findFirst: async () => null },
    }, () => handler({ params: { id: '1' }, user }, res))
    return res.statusCode
  }
  assert.equal(await run(undefined), 404)
  assert.equal(await run({ id: 30 }), 404)
  assert.equal(await run({ id: 10 }), 200)
})
