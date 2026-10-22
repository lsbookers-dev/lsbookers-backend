// routes/payouts.js — Réglages › Paiements : comment la personne bookée est payée.
// Facture via une structure → compte de paiement Stripe (vérification d'identité par Stripe).
// Intermittent payé en cachet (GUSO) → paiement en direct uniquement, avec rappel de la loi.
const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { getStripe, siteUrl, stripeUnavailable } = require('../lib/stripe')

const PAYEE_ROLES = ['ARTIST', 'PROVIDER', 'ORGANIZER'] // un prestataire ou organisateur peut aussi être booké

// Comptes « Accounts v2 » de Stripe (imposés pour les nouvelles plateformes depuis 2026) :
// le compte de l'artiste a la configuration « recipient » (il reçoit des virements de LS Bookers)
async function refreshAccount(stripe, user) {
  if (!user.stripeAccountId) return null
  const account = await stripe.v2.core.accounts.retrieve(user.stripeAccountId, { include: ['configuration.recipient', 'requirements'] })
  const transfers = account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status
  const ready = transfers === 'active'
  if (ready !== user.isPaymentEnabled || ready !== user.isIdentityVerified) {
    await prisma.user.update({ where: { id: user.id }, data: { isPaymentEnabled: ready, isIdentityVerified: ready } })
  }
  const due = (account.requirements?.entries || []).filter(e => ['currently_due', 'past_due'].includes(e.minimum_deadline?.status))
  return { ready, detailsSubmitted: ready || due.length === 0, pendingRequirements: due.length, status: transfers || null }
}

// L'argent reste sur le compte LS Bookers de l'artiste jusqu'à ce qu'il clique sur « Retirer »
async function ensureManualPayouts(stripe, accountId) {
  try {
    const acc = await stripe.accounts.retrieve(accountId)
    if (acc.settings?.payouts?.schedule?.interval !== 'manual') {
      await stripe.accounts.update(accountId, { settings: { payouts: { schedule: { interval: 'manual' } } } })
    }
  } catch (err) {
    console.error('Virements manuels impossibles à régler :', err.message)
  }
}

const eurOf = (list) => (list || []).filter(x => x.currency === 'eur').reduce((s, x) => s + x.amount, 0)
const DAY = 24 * 60 * 60 * 1000

// GET /api/payouts/balance — compteur « Mon argent sur LS Bookers »
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { stripeAccountId: true, isPaymentEnabled: true, profile: { select: { id: true } } } })
    const profileId = user?.profile?.id
    // À venir : bookings payés en ligne, pas encore versés (versement 24 h après la prestation)
    const paid = profileId ? await prisma.bookingPayment.findMany({
      where: { payeeId: profileId, status: 'PAID' },
      include: { booking: { select: { id: true, startDate: true, endDate: true, eventId: true, event: { select: { title: true } }, requester: { select: { user: { select: { pseudo: true, firstName: true, lastName: true } } } } } } },
      orderBy: { booking: { startDate: 'asc' } },
    }) : []
    const upcoming = paid.map(p => ({
      bookingId: p.booking.id,
      eventId: p.booking.eventId,
      title: p.booking.event?.title || null,
      from: p.booking.requester?.user?.pseudo || [p.booking.requester?.user?.firstName, p.booking.requester?.user?.lastName].filter(Boolean).join(' ') || null,
      date: p.booking.startDate,
      netCents: Math.max(0, p.amountCents - p.commissionCents - p.transferredCents),
      acquiredCents: Math.round(p.amountCents * p.depositPct / 100),
    }))
    const result = {
      hasAccount: !!user?.stripeAccountId,
      ready: !!user?.isPaymentEnabled,
      availableCents: 0,
      pendingCents: 0,
      upcomingCents: upcoming.reduce((s, u) => s + u.netCents, 0),
      acquiredCents: upcoming.reduce((s, u) => s + u.acquiredCents, 0),
      withdrawnYearCents: 0,
      lastWithdrawal: null,
      upcoming: upcoming.slice(0, 10),
      withdrawals: [],
    }
    const stripe = getStripe()
    if (stripe && user?.stripeAccountId) {
      await ensureManualPayouts(stripe, user.stripeAccountId)
      const opts = { stripeAccount: user.stripeAccountId }
      const yearStart = Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000)
      const [balance, payouts] = await Promise.all([
        stripe.balance.retrieve({}, opts).catch(() => null),
        stripe.payouts.list({ limit: 100, created: { gte: yearStart } }, opts).catch(() => null),
      ])
      if (balance) {
        result.availableCents = eurOf(balance.available)
        result.pendingCents = eurOf(balance.pending) // versé par LS Bookers, bientôt disponible
      }
      const done = (payouts?.data || []).filter(p => p.currency === 'eur' && ['paid', 'in_transit', 'pending'].includes(p.status))
      result.withdrawnYearCents = done.reduce((s, p) => s + p.amount, 0)
      result.withdrawals = done.slice(0, 5).map(p => ({ amountCents: p.amount, status: p.status, createdAt: new Date(p.created * 1000), arrivalDate: p.arrival_date ? new Date(p.arrival_date * 1000) : null }))
      result.lastWithdrawal = result.withdrawals[0]?.createdAt || null
    }
    res.json(result)
  } catch (err) {
    console.error('GET /payouts/balance', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/payouts/withdraw — virer tout le disponible vers le compte bancaire de l'artiste
router.post('/withdraw', requireAuth, async (req, res) => {
  const stripe = getStripe()
  if (!stripe) return stripeUnavailable(res)
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { stripeAccountId: true, isPaymentEnabled: true } })
    if (!user?.stripeAccountId || !user.isPaymentEnabled) return res.status(400).json({ error: 'NO_ACCOUNT', message: 'Activez d’abord votre compte de paiement.' })
    const opts = { stripeAccount: user.stripeAccountId }
    const balance = await stripe.balance.retrieve({}, opts)
    const amount = eurOf(balance.available)
    if (amount < 100) return res.status(400).json({ error: 'NOTHING_TO_WITHDRAW', message: 'Il faut au moins 1 € disponible pour faire un retrait.' })
    const payout = await stripe.payouts.create({ amount, currency: 'eur', description: 'Retrait LS Bookers' }, opts)
    res.json({ amountCents: payout.amount, arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : new Date(Date.now() + 2 * DAY) })
  } catch (err) {
    console.error('POST /payouts/withdraw', err)
    res.status(500).json({ error: 'Erreur serveur', message: err.raw?.message ? 'Le retrait n’a pas pu être lancé : vérifiez votre compte bancaire sur Stripe.' : 'Le retrait n’a pas pu être lancé pour le moment.' })
  }
})

// GET /api/payouts/status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, role: true, payoutMode: true, stripeAccountId: true, isPaymentEnabled: true, isIdentityVerified: true, profile: { select: { legalStatus: true } } },
    })
    const stripe = getStripe()
    let account = null
    if (stripe && user.stripeAccountId) account = await refreshAccount(stripe, user).catch(() => null)
    const intermittent = user.payoutMode === 'INTERMITTENT' || user.profile?.legalStatus === 'INTERMITTENT'
    res.json({
      available: !!stripe,
      payoutMode: user.payoutMode || (user.profile?.legalStatus === 'INTERMITTENT' ? 'INTERMITTENT' : null),
      intermittent,
      hasAccount: !!user.stripeAccountId,
      ready: account ? account.ready : !!user.isPaymentEnabled,
      detailsSubmitted: account?.detailsSubmitted ?? false,
      pendingRequirements: account?.pendingRequirements ?? 0,
    })
  } catch (err) {
    console.error('GET /payouts/status', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// PUT /api/payouts/mode { mode: INVOICE | INTERMITTENT }
router.put('/mode', requireAuth, async (req, res) => {
  const mode = String(req.body?.mode || '').toUpperCase()
  if (!['INVOICE', 'INTERMITTENT'].includes(mode)) return res.status(400).json({ error: 'Choix invalide' })
  try {
    await prisma.user.update({ where: { id: req.user.id }, data: { payoutMode: mode } })
    res.json({ payoutMode: mode })
  } catch (err) {
    console.error('PUT /payouts/mode', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/payouts/onboard — créer / compléter le compte de paiement (page Stripe)
router.post('/onboard', requireAuth, async (req, res) => {
  const stripe = getStripe()
  if (!stripe) return stripeUnavailable(res)
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, role: true, payoutMode: true, stripeAccountId: true, profile: { select: { legalStatus: true, country: true } } },
    })
    if (!PAYEE_ROLES.includes(user.role)) return res.status(403).json({ error: 'Non autorisé' })
    if (user.payoutMode === 'INTERMITTENT' || user.profile?.legalStatus === 'INTERMITTENT') {
      return res.status(400).json({ error: 'PAYEE_INTERMITTENT', message: 'Payé en cachet, vous êtes réglé en direct par l’organisateur (déclaration GUSO).' })
    }
    let accountId = user.stripeAccountId
    if (!accountId) {
      const account = await stripe.v2.core.accounts.create({
        contact_email: user.email,
        identity: { country: 'FR' }, // lancement en France ; un pays par compte quand LS Bookers s'ouvrira à l'Europe
        dashboard: 'express',
        defaults: {
          locales: ['fr-FR'],
          // LS Bookers paie les frais Stripe et porte les pertes (contestations reprises ensuite sur le versement)
          responsibilities: { fees_collector: 'application', losses_collector: 'application' },
        },
        configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
        metadata: { userId: String(user.id) },
      })
      accountId = account.id
      await prisma.user.update({ where: { id: user.id }, data: { stripeAccountId: accountId, payoutMode: 'INVOICE' } })
      await ensureManualPayouts(stripe, accountId)
    }
    const link = await stripe.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          refresh_url: `${siteUrl()}/settings/subscription?stripe=retry`,
          return_url: `${siteUrl()}/settings/subscription?stripe=ok`,
        },
      },
    })
    res.json({ url: link.url })
  } catch (err) {
    console.error('POST /payouts/onboard', err)
    res.status(500).json({ error: 'Erreur serveur', message: 'Impossible d’ouvrir la page Stripe pour le moment.' })
  }
})

// POST /api/payouts/dashboard — tableau de bord Stripe (virements reçus, coordonnées bancaires)
router.post('/dashboard', requireAuth, async (req, res) => {
  const stripe = getStripe()
  if (!stripe) return stripeUnavailable(res)
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { stripeAccountId: true } })
    if (!user?.stripeAccountId) return res.status(400).json({ error: 'NO_ACCOUNT' })
    const link = await stripe.accounts.createLoginLink(user.stripeAccountId)
    res.json({ url: link.url })
  } catch (err) {
    console.error('POST /payouts/dashboard', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
