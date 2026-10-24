// Jamais d'e-mail réel, même si ce fichier est lancé seul (la clé Resend du .env est chargée par Prisma)
process.env.LSB_DISABLE_EMAILS = '1'

const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const { notifyMany } = require('../services/notifications')

test('envoi groupé : cloches en une fois, e-mails selon les réglages, jamais à l\'auteur', async () => {
  const originals = { findMany: prisma.user.findMany, createMany: prisma.notification.createMany }
  const created = []
  let lookups = 0
  prisma.user.findMany = async ({ where }) => {
    lookups++
    return where.id.in.map(id => ({
      id,
      email: `membre${id}@test.local`,
      // Membre 3 : pas de cloche pour les offres ; membre 4 : pas d'e-mail
      notifPrefs: id === 3 ? { offers: { bell: false, email: true } } : id === 4 ? { offers: { bell: true, email: false } } : null,
    }))
  }
  prisma.notification.createMany = async ({ data }) => { created.push(...data); return { count: data.length } }
  try {
    const result = await notifyMany({
      userIds: [2, 3, 4, 5, 5, 9],
      type: 'NEW_OFFER',
      content: 'Orga a publié une nouvelle offre : "Soirée".',
      actorId: 9,
      offerId: 12,
    })
    assert.equal(lookups, 1)
    // 9 = l'auteur, 5 en double : une seule fois
    assert.deepEqual(created.map(n => n.userId).sort(), [2, 4, 5])
    assert.ok(created.every(n => n.type === 'NEW_OFFER' && n.offerId === 12 && n.actorId === 9))
    assert.deepEqual(result, { bell: 3, email: 3 }) // e-mails : 2, 3, 5
  } finally {
    prisma.user.findMany = originals.findMany
    prisma.notification.createMany = originals.createMany
  }
})

test('envoi groupé : personne à prévenir = aucune requête', async () => {
  const result = await notifyMany({ userIds: [7], type: 'NEW_OFFER', content: 'x', actorId: 7 })
  assert.deepEqual(result, { bell: 0, email: 0 })
})
