// services/offerCleanup.js — Suppression des offres dont la date est passée.
// Une offre est supprimée le lendemain de sa date (ou de sa date de fin),
// avec ses candidatures. Les notifications qui la mentionnaient sont gardées
// mais ne pointent plus vers elle.

const prisma = require('../prisma/client')

const GRACE_MS = 24 * 60 * 60 * 1000 // 24 h après la date de l'offre
const INTERVAL_MS = 60 * 60 * 1000   // vérification toutes les heures

// Filtre Prisma : offres terminées depuis plus de 24 h
function expiredOfferWhere(now = new Date()) {
  const cutoff = new Date(now.getTime() - GRACE_MS)
  return { OR: [{ endDate: { lt: cutoff } }, { endDate: null, date: { lt: cutoff } }] }
}

async function deleteExpiredOffers(now = new Date()) {
  const expired = await prisma.offer.findMany({ where: expiredOfferWhere(now), select: { id: true } })
  if (!expired.length) return 0
  const ids = expired.map(o => o.id)
  await prisma.$transaction([
    prisma.notification.updateMany({ where: { offerId: { in: ids } }, data: { offerId: null } }),
    prisma.application.deleteMany({ where: { offerId: { in: ids } } }),
    prisma.offer.deleteMany({ where: { id: { in: ids } } }),
  ])
  console.log(`🧹 ${ids.length} offre(s) passée(s) supprimée(s)`)
  return ids.length
}

function startOfferCleanup() {
  const run = () => deleteExpiredOffers().catch(err => console.error('❌ Nettoyage des offres :', err.message))
  run()
  setInterval(run, INTERVAL_MS).unref()
}

module.exports = { expiredOfferWhere, deleteExpiredOffers, startOfferCleanup }
