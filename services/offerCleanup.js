// services/offerCleanup.js — Suppression des offres dont la date est passée.
// Une offre est supprimée le lendemain de sa date (ou de sa date de fin),
// avec ses candidatures. Les notifications qui la mentionnaient sont gardées
// mais ne pointent plus vers elle.

const prisma = require('../prisma/client')

const GRACE_MS = 24 * 60 * 60 * 1000 // 24 h après la date de l'offre

// Filtre Prisma : offres terminées depuis plus de 24 h
function expiredOfferWhere(now = new Date()) {
  const cutoff = new Date(now.getTime() - GRACE_MS)
  return { OR: [{ endDate: { lt: cutoff } }, { endDate: null, date: { lt: cutoff } }] }
}

// Filtre Prisma : offres encore en cours (l'inverse exact du précédent).
// Écrit en positif : un NOT(OR(...)) écarterait aussi les offres sans date de fin,
// car la base compare « date de fin vide < limite » à « inconnu », pas à « faux ».
function activeOfferWhere(now = new Date()) {
  const cutoff = new Date(now.getTime() - GRACE_MS)
  return { OR: [{ endDate: { gte: cutoff } }, { endDate: null, date: { gte: cutoff } }] }
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

module.exports = { expiredOfferWhere, activeOfferWhere, deleteExpiredOffers }
