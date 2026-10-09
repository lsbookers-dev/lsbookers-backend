// services/scheduledJobs.js — Tâches automatiques lancées au démarrage puis toutes les heures

const { deleteExpiredOffers } = require('./offerCleanup')
const { sendReviewInvites } = require('./reviewInvites')

const INTERVAL_MS = 60 * 60 * 1000

const JOBS = [
  ['Nettoyage des offres passées', deleteExpiredOffers],
  ['Invitations à laisser un avis', sendReviewInvites],
]

function startScheduledJobs() {
  const run = async () => {
    for (const [label, job] of JOBS) {
      try { await job() } catch (err) { console.error(`❌ ${label} :`, err.message) }
    }
  }
  run()
  setInterval(run, INTERVAL_MS).unref()
}

module.exports = { startScheduledJobs }
