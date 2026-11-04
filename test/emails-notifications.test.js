process.env.LSB_DISABLE_EMAILS = '1'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-emails'
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test'

const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const { sendPendingEmails, pendingData } = require('../services/pendingEmails')
const { unsubscribeToken, readUnsubscribeToken, unsubscribeLinks } = require('../lib/notificationEmail')
const emailUtils = require('../utils/email')

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

const row = (id, type, notificationId, extra = {}) => ({
  id, userId: 7, type, notificationId, subject: `Objet ${id}`, title: `Titre ${id}`, content: `Texte ${id}`,
  link: 'https://lsbookers.com/x', ctaLabel: 'Voir', details: null, createdAt: new Date(Date.now() - 11 * 60000), ...extra,
})

function captureSends(fn) {
  const sent = []
  const original = emailUtils.sendPreparedEmails
  emailUtils.sendPreparedEmails = async (payloads) => { sent.push(...payloads); return payloads.length }
  return fn().finally(() => { emailUtils.sendPreparedEmails = original }).then(() => sent)
}

const baseMocks = (pending, unreadIds, user = { email: 'a@b.fr', emailVerified: true, notifPrefs: null }) => ({
  pendingEmail: {
    groupBy: async () => [{ userId: 7 }],
    findMany: async () => pending,
    deleteMany: async ({ where }) => ({ count: where.id.in.length }),
  },
  user: { findUnique: async () => user },
  notification: { findMany: async ({ where }) => where.id.in.filter(id => unreadIds.includes(id)).map(id => ({ id })) },
})

test('déjà vue sur le site avant 10 min : pas d’e-mail', async () => {
  const sent = await withMocks(baseMocks([row(1, 'BOOKING_REQUEST', 50)], []), () => captureSends(() => sendPendingEmails()))
  assert.equal(sent.length, 0)
})

test('une seule nouveauté : e-mail détaillé avec désinscription en un clic', async () => {
  const sent = await withMocks(baseMocks([row(1, 'BOOKING_REQUEST', 50, { details: { rows: [['Cachet proposé', '800 €']] } })], [50]), () => captureSends(() => sendPendingEmails()))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].subject, 'Objet 1')
  assert.ok(sent[0].html.includes('800 €'))
  assert.match(sent[0].headers['List-Unsubscribe'], /\/api\/email\/unsubscribe\?token=/)
  assert.equal(sent[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
})

test('plusieurs nouveautés : un seul e-mail groupé', async () => {
  const pending = [row(1, 'BOOKING_REQUEST', 50), row(2, 'NEW_OFFER', null), row(3, 'NEW_APPLICATION', 52)]
  const sent = await withMocks(baseMocks(pending, [50, 52]), () => captureSends(() => sendPendingEmails()))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].subject, '3 nouveautés sur LS Bookers')
})

test('adresse non confirmée ou e-mails coupés depuis : rien ne part', async () => {
  const unverified = await withMocks(baseMocks([row(1, 'BOOKING_REQUEST', 50)], [50], { email: 'a@b.fr', emailVerified: false, notifPrefs: null }), () => captureSends(() => sendPendingEmails()))
  assert.equal(unverified.length, 0)
  const optedOut = await withMocks(baseMocks([row(1, 'BOOKING_REQUEST', 50)], [50], { email: 'a@b.fr', emailVerified: true, notifPrefs: { bookings: { email: false } } }), () => captureSends(() => sendPendingEmails()))
  assert.equal(optedOut.length, 0)
})

test('contenu en attente : objet précis et lien vers la conversation du booking', async () => {
  const data = await withMocks({ message: { findUnique: async () => ({ conversationId: 31 }) } }, () => pendingData({
    userId: 7, type: 'BOOKING_REQUEST', content: 'Nouvelle proposition de booking', messageId: 4, notificationId: 50,
    email: { subject: 'Proposition de booking · 12 déc.', rows: [['Date', '12 déc.']] },
  }))
  assert.equal(data.subject, 'Proposition de booking · 12 déc.')
  assert.equal(data.link, 'https://lsbookers.com/messages?c=31')
  assert.equal(data.ctaLabel, 'Voir la demande')
  assert.deepEqual(data.details.rows, [['Date', '12 déc.']])
})

test('jeton de désinscription : seulement pour arrêter des e-mails', () => {
  const t = unsubscribeToken(7, ['bookings', 'offers'])
  assert.deepEqual(readUnsubscribeToken(t), { userId: 7, categories: ['bookings', 'offers'] })
  assert.equal(readUnsubscribeToken('faux'), null)
  const links = unsubscribeLinks(7, ['BOOKING_REQUEST'])
  assert.equal(links.label, 'Ne plus recevoir les e-mails « Bookings »')
})

test('désinscription : coupe seulement les e-mails des sujets du lien', async () => {
  const router = require('../routes/emailPrefs')
  const handler = router.stack.find(l => l.route?.path === '/unsubscribe' && l.route.methods.post).route.stack.at(-1).handle
  let saved
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(b) { this.body = b; return this } }
  await withMocks({
    user: {
      findUnique: async () => ({ id: 7, notifPrefs: { bookings: { bell: true, email: true }, network: { email: true } } }),
      update: async ({ data }) => { saved = data.notifPrefs },
    },
  }, () => handler({ query: { token: unsubscribeToken(7, ['bookings']) }, body: {} }, res))
  assert.deepEqual(saved, { bookings: { bell: true, email: false }, network: { email: true } })
  const bad = { ...res, statusCode: 200 }
  await handler({ query: { token: 'faux' }, body: {} }, bad)
  assert.equal(bad.statusCode, 400)
})
