const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const settingsRouter = require('../routes/adminSettings')
const { adminSettingsUpdateSchema } = require('../schemas')

test('annonce de l\'en-tête : lien interne ou https uniquement', () => {
  const ok = url => adminSettingsUpdateSchema.safeParse({ announcementUrl: url }).success
  assert.equal(ok('/space'), true)
  assert.equal(ok('https://lsbookers.com/offers'), true)
  assert.equal(ok(''), true)
  assert.equal(ok('http://exemple.fr'), false)
  assert.equal(ok('//exemple.fr'), false)
  assert.equal(ok('javascript:alert(1)'), false)
  assert.equal(adminSettingsUpdateSchema.safeParse({ announcementText: 'x'.repeat(141) }).success, false)
})

test('annonce de l\'en-tête : renvoyée avec les réglages publics', async () => {
  const layer = settingsRouter.stack.find(l => l.route?.path === '/' && l.route.methods.get)
  const res = { set() {}, status() { return this }, json(b) { this.body = b; return this } }
  const original = prisma.adminSettings.findUnique
  prisma.adminSettings.findUnique = async () => ({ id: 1, announcementText: 'Nouveau : les devis', announcementUrl: '/space', announcementActive: true })
  try { await layer.route.stack.at(-1).handle({}, res) } finally { prisma.adminSettings.findUnique = original }
  assert.equal(res.body.announcementText, 'Nouveau : les devis')
  assert.equal(res.body.announcementUrl, '/space')
  assert.equal(res.body.announcementActive, true)
})
