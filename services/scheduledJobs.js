// services/scheduledJobs.js — Tâches automatiques lancées au démarrage puis toutes les heures
// (les paiements de bookings, eux, sont vérifiés tous les quarts d'heure)

const prisma = require('../prisma/client')
const { deleteExpiredOffers } = require('./offerCleanup')
const { sendReviewInvites } = require('./reviewInvites')
const { sendChecklistReminders } = require('./checklistReminders')
const { sendWeeklyRecaps } = require('./weeklyRecap')
const { chargeDuePayments, releaseDuePayouts } = require('./bookingPayments')
const { dailyBackupIfDue } = require('./dbBackup')
const { endLapsedManagements } = require('./agency')

const INTERVAL_MS = 60 * 60 * 1000
const PAYMENTS_INTERVAL_MS = 15 * 60 * 1000

// Mises en avant payantes terminées : la commande passe en « réalisée »
async function closeFinishedFeatures() {
  const ended = await prisma.homeFeatured.findMany({
    where: { orderId: { not: null }, endsAt: { lte: new Date() }, order: { status: 'ACTIVE' } },
    select: { orderId: true },
  })
  if (ended.length) {
    await prisma.extraOrder.updateMany({ where: { id: { in: ended.map(f => f.orderId) } }, data: { status: 'DONE' } })
  }
}

const JOBS = [
  ['Nettoyage des offres passées', deleteExpiredOffers],
  ['Invitations à laisser un avis', sendReviewInvites],
  ['Rappels de checklist', sendChecklistReminders],
  ['Récap e-mail du lundi', sendWeeklyRecaps],
  ['Fin des mises en avant payantes', closeFinishedFeatures],
  ['Sauvegarde quotidienne de la base', dailyBackupIfDue],
  ['Fin des gestions d’agences sans formule depuis 30 jours', () => endLapsedManagements()],
]

const PAYMENT_JOBS = [
  ['Débit des bookings payés en ligne', () => chargeDuePayments()],
  ['Versements 24 h après la prestation', () => releaseDuePayouts()],
]

function every(jobs, intervalMs) {
  const run = async () => {
    for (const [label, job] of jobs) {
      try { await job() } catch (err) { console.error(`❌ ${label} :`, err.message) }
    }
  }
  run()
  setInterval(run, intervalMs).unref()
}

function startScheduledJobs() {
  every(JOBS, INTERVAL_MS)
  every(PAYMENT_JOBS, PAYMENTS_INTERVAL_MS)
}

module.exports = { startScheduledJobs, closeFinishedFeatures }
