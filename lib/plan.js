// lib/plan.js — Compte Gratuit / Pro : qui est Pro, limites du compte gratuit.
// Toute limite est vérifiée ici, côté serveur ; le site n'affiche que le résultat.
const prisma = require('../prisma/client')
const { getPlanSettings } = require('./planSettings')

const PRO_STATUSES = new Set(['TRIAL', 'ACTIVE', 'PAST_DUE'])

// Un abonnement donne le Pro s'il est en cours (essai, payé, ou prélèvement en cours de relance),
// ou résilié mais pas encore arrivé au bout de la période payée.
function isProSubscription(sub, now = new Date()) {
  if (!sub) return false
  if (sub.endDate && new Date(sub.endDate) <= now) return false
  if (PRO_STATUSES.has(sub.status)) return true
  if (sub.status === 'CANCELLED' && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) > now) return true
  return false
}

async function getPlan(user) {
  const userId = typeof user === 'object' ? user.id : user
  const role = typeof user === 'object' ? user.role : null
  if (String(role || '').toUpperCase() === 'ADMIN') return { isPro: true, subscription: null }
  const subscription = await prisma.subscription.findUnique({ where: { userId } })
  return { isPro: isProSubscription(subscription), subscription }
}

async function isPro(user) {
  return (await getPlan(user)).isPro
}

// Début du mois en cours (heure de Paris), pour les limites « par mois »
function startOfMonthParis(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).formatToParts(now)
  const y = Number(parts.find(p => p.type === 'year').value)
  const m = Number(parts.find(p => p.type === 'month').value)
  // Minuit à Paris = 22 h ou 23 h UTC la veille : on prend la marge la plus large (22 h UTC)
  return new Date(Date.UTC(y, m - 1, 1) - 2 * 60 * 60 * 1000)
}

const LIMIT_MESSAGES = {
  applicationsPerMonth: (max) => `Avec le compte gratuit, vous pouvez envoyer ${max} candidatures par mois. Passez en Pro pour postuler sans limite.`,
  bookingRequestsPerMonth: (max) => `Avec le compte gratuit, vous pouvez envoyer ${max} demandes de booking par mois. Passez en Pro pour en envoyer sans limite.`,
  activeEvents: (max) => `Avec le compte gratuit, vous pouvez avoir ${max} événements en même temps dans votre agenda. Passez en Pro pour en créer sans limite.`,
  activeOffers: (max) => `Avec le compte gratuit, vous pouvez publier ${max} offre${max > 1 ? 's' : ''} à la fois. Passez en Pro pour en publier sans limite.`,
  albums: (max) => `Avec le compte gratuit, vous pouvez créer ${max} albums. Passez en Pro pour en créer sans limite.`,
  videos: (max) => `Avec le compte gratuit, vous pouvez publier ${max} vidéos. Passez en Pro pour en publier sans limite.`,
  videoMaxSeconds: (max) => `Avec le compte gratuit, une vidéo dure au maximum ${max} secondes. Passez en Pro pour publier des vidéos plus longues.`,
}

function limitError(limit, max, used) {
  return { error: 'PRO_LIMIT', limit, max, used, message: LIMIT_MESSAGES[limit](max) }
}

// Compteurs actuels pour chaque limite
const COUNTERS = {
  applicationsPerMonth: ({ profileId }) => prisma.application.count({ where: { applicantId: profileId, createdAt: { gte: startOfMonthParis() } } }),
  bookingRequestsPerMonth: ({ profileId }) => prisma.bookingRequest.count({ where: { requesterId: profileId, createdAt: { gte: startOfMonthParis() } } }),
  activeEvents: ({ profileId }) => {
    const now = new Date()
    return prisma.event.count({
      where: {
        profileId,
        status: { notIn: ['CANCELLED', 'COMPLETED'] },
        OR: [{ end: { gte: now } }, { end: null, start: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }],
      },
    })
  },
  activeOffers: ({ profileId }) => prisma.offer.count({ where: { organizerId: profileId, status: 'ACTIVE' } }),
  albums: ({ profileId }) => prisma.album.count({ where: { profileId } }),
  videos: async ({ profileId }) => {
    const [main, extra] = await Promise.all([
      prisma.publication.count({ where: { profileId, mediaType: 'video' } }),
      prisma.publicationMedia.count({ where: { mediaType: 'video', publication: { profileId } } }),
    ])
    return main + extra
  },
}

/**
 * Vérifie une limite du compte gratuit avant une création.
 * Renvoie null si c'est permis, sinon l'objet d'erreur à renvoyer (statut 403).
 * `adding` = nombre d'éléments que l'action va ajouter (ex. 2 vidéos dans une publication).
 */
async function checkLimit(user, limit, { profileId, adding = 1 } = {}) {
  if (await isPro(user)) return null
  const settings = await getPlanSettings()
  const max = Number(settings.limits?.[limit])
  if (!Number.isFinite(max) || max < 0) return null
  const used = await COUNTERS[limit]({ profileId })
  if (used + adding > max) return limitError(limit, max, used)
  return null
}

// Durée des vidéos (envoyée par le site, qui la lit avant l'envoi)
async function checkVideoDurations(user, durations) {
  const list = (Array.isArray(durations) ? durations : []).map(Number).filter(Number.isFinite)
  if (!list.length || await isPro(user)) return null
  const settings = await getPlanSettings()
  const max = Number(settings.limits?.videoMaxSeconds)
  if (!Number.isFinite(max) || max <= 0) return null
  // 1 s de tolérance (arrondis des navigateurs)
  if (list.some(d => d > max + 1)) return limitError('videoMaxSeconds', max)
  return null
}

// Middleware : fonctionnalité réservée au Pro (module Finances, devis et factures…)
async function requirePro(req, res, next) {
  try {
    if (await isPro(req.user)) return next()
    return res.status(403).json({ error: 'PRO_REQUIRED', message: 'Cette fonctionnalité est disponible avec la version Pro.' })
  } catch (err) {
    console.error('requirePro:', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}

// Coup de pouce dans la recherche : un compte Pro remonte de quelques places, sans passer
// systématiquement devant tout le monde (sinon les comptes gratuits deviendraient invisibles)
const SEARCH_BOOST_PLACES = 3
function boostPro(list, isProFn, places = SEARCH_BOOST_PLACES) {
  return list
    .map((item, index) => ({ item, score: index - (isProFn(item) ? places + 0.5 : 0) }))
    .sort((a, b) => a.score - b.score)
    .map(x => x.item)
}

module.exports = { boostPro, isProSubscription, getPlan, isPro, checkLimit, checkVideoDurations, requirePro, startOfMonthParis, limitError }
