// routes/billing.js — Page « Offres et abonnements » : statut Pro, limites, abonnement, codes, formules
const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { getPlan, startOfMonthParis } = require('../lib/plan')
const { getPlanSettings } = require('../lib/planSettings')
const { getStripe } = require('../lib/stripe')
const billing = require('../services/billing')
const extras = require('../services/extras')

const MEMBER_ROLES = ['ARTIST', 'ORGANIZER', 'PROVIDER']

function sendError(res, err, label) {
  if (err instanceof billing.BillingError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...(err.nextFreeDate !== undefined ? { nextFreeDate: err.nextFreeDate } : {}) })
  }
  console.error(label, err)
  return res.status(500).json({ error: 'Erreur serveur' })
}

// Ce que le membre a déjà utilisé ce mois-ci (affiché à côté des limites)
async function usage(profileId) {
  if (!profileId) return null
  const now = new Date()
  const month = startOfMonthParis()
  const [applications, bookingRequests, activeEvents, activeOffers, albums, videosMain, videosExtra] = await Promise.all([
    prisma.application.count({ where: { applicantId: profileId, createdAt: { gte: month } } }),
    prisma.bookingRequest.count({ where: { requesterId: profileId, createdAt: { gte: month } } }),
    prisma.event.count({ where: { profileId, status: { notIn: ['CANCELLED', 'COMPLETED'] }, OR: [{ end: { gte: now } }, { end: null, start: { gte: new Date(now.getTime() - 86400000) } }] } }),
    prisma.offer.count({ where: { organizerId: profileId, status: 'ACTIVE' } }),
    prisma.album.count({ where: { profileId } }),
    prisma.publication.count({ where: { profileId, mediaType: 'video' } }),
    prisma.publicationMedia.count({ where: { mediaType: 'video', publication: { profileId } } }),
  ])
  return { applicationsPerMonth: applications, bookingRequestsPerMonth: bookingRequests, activeEvents, activeOffers, albums, videos: videosMain + videosExtra }
}

// GET /api/billing/me — statut Pro, prix selon le rôle, limites et utilisation
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [settings, plan, profile] = await Promise.all([
      getPlanSettings(),
      getPlan(req.user),
      prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } }),
    ])
    const sub = plan.subscription
    const role = String(req.user.role || '').toUpperCase()
    res.json({
      isPro: plan.isPro,
      role,
      paymentsAvailable: !!getStripe(),
      subscription: sub ? {
        status: sub.status, interval: sub.interval, source: sub.source, priceCents: sub.priceCents,
        trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        promoCode: sub.promoCode, startDate: sub.startDate,
      } : null,
      trialAvailable: !(sub && (sub.trialEndsAt || sub.stripeSubId)) && settings.trialDays > 0,
      trialDays: settings.trialDays,
      prices: MEMBER_ROLES.includes(role) ? settings.prices[role] : null,
      allPrices: settings.prices,
      commission: settings.commission,
      limits: settings.limits,
      usage: await usage(profile?.id),
    })
  } catch (err) {
    sendError(res, err, 'GET /billing/me')
  }
})

// POST /api/billing/checkout { interval: MONTH|YEAR, promoCode? } — page de paiement Stripe
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const interval = String(req.body?.interval || '').toUpperCase()
    const result = await billing.createSubscriptionCheckout({ user: req.user, interval, promoCode: req.body?.promoCode || null })
    res.json(result)
  } catch (err) {
    sendError(res, err, 'POST /billing/checkout')
  }
})

// POST /api/billing/promo/check { code } — vérifier un code avant de payer (affiche les mois offerts)
router.post('/promo/check', requireAuth, async (req, res) => {
  try {
    const promo = await billing.checkPromoCode(req.body?.code, req.user.id)
    res.json({ code: promo.code, kind: promo.kind, freeMonths: promo.freeMonths })
  } catch (err) {
    sendError(res, err, 'POST /billing/promo/check')
  }
})

// POST /api/billing/founder { code } — code Fondateur : Pro offert à vie, sans carte
router.post('/founder', requireAuth, async (req, res) => {
  try {
    if (!MEMBER_ROLES.includes(String(req.user.role || '').toUpperCase())) return res.status(403).json({ error: 'ROLE_NOT_ELIGIBLE' })
    await billing.applyFounderCode({ user: req.user, code: req.body?.code })
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err, 'POST /billing/founder')
  }
})

// POST /api/billing/portal — espace client Stripe (carte, résiliation, factures)
router.post('/portal', requireAuth, async (req, res) => {
  try {
    res.json(await billing.createPortalSession(req.user))
  } catch (err) {
    sendError(res, err, 'POST /billing/portal')
  }
})

// GET /api/billing/extras — formules supplémentaires et places libres dans le carrousel
router.get('/extras', requireAuth, async (req, res) => {
  try {
    res.json(await extras.publicCatalog(req.user))
  } catch (err) {
    sendError(res, err, 'GET /billing/extras')
  }
})

// POST /api/billing/extras/checkout { offerId, optionId, startDate? }
router.post('/extras/checkout', requireAuth, async (req, res) => {
  try {
    if (!MEMBER_ROLES.includes(String(req.user.role || '').toUpperCase())) return res.status(403).json({ error: 'ROLE_NOT_ELIGIBLE' })
    res.json(await extras.createExtraCheckout({ user: req.user, offerId: req.body?.offerId, optionId: String(req.body?.optionId || ''), startDate: req.body?.startDate || null }))
  } catch (err) {
    sendError(res, err, 'POST /billing/extras/checkout')
  }
})

// GET /api/billing/orders — mes formules achetées
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const orders = await prisma.extraOrder.findMany({
      where: { userId: req.user.id, status: { not: 'PENDING_PAYMENT' } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { featured: { select: { startsAt: true, endsAt: true } } },
    })
    res.json({ orders: orders.map(o => ({ id: o.id, label: o.label, status: o.status, amountCents: o.amountCents, scope: o.scope, createdAt: o.createdAt, startsAt: o.featured?.startsAt ?? o.desiredStart, endsAt: o.featured?.endsAt ?? null })) })
  } catch (err) {
    sendError(res, err, 'GET /billing/orders')
  }
})

module.exports = router
module.exports.sendError = sendError
