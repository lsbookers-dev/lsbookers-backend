// routes/payouts.js — Réglages › Paiements : comment la personne bookée est payée.
// Facture via une structure → compte de paiement Stripe (vérification d'identité par Stripe).
// Intermittent payé en cachet (GUSO) → paiement en direct uniquement, avec rappel de la loi.
const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { getStripe, siteUrl, stripeUnavailable } = require('../lib/stripe')

const PAYEE_ROLES = ['ARTIST', 'PROVIDER', 'ORGANIZER'] // un prestataire ou organisateur peut aussi être booké

async function refreshAccount(stripe, user) {
  if (!user.stripeAccountId) return null
  const account = await stripe.accounts.retrieve(user.stripeAccountId)
  const ready = !!(account.details_submitted && account.payouts_enabled && account.capabilities?.transfers === 'active')
  if (ready !== user.isPaymentEnabled || ready !== user.isIdentityVerified) {
    await prisma.user.update({ where: { id: user.id }, data: { isPaymentEnabled: ready, isIdentityVerified: ready } })
  }
  return {
    ready,
    detailsSubmitted: !!account.details_submitted,
    pendingRequirements: (account.requirements?.currently_due || []).length,
  }
}

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
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'FR', // lancement en France ; un pays par compte quand LS Bookers s'ouvrira à l'Europe
        email: user.email,
        capabilities: { transfers: { requested: true } },
        business_profile: { mcc: '7929', product_description: 'Prestations artistiques et événementielles réservées via LS Bookers' },
        settings: { payouts: { schedule: { interval: 'daily' } } },
        metadata: { userId: String(user.id) },
      })
      accountId = account.id
      await prisma.user.update({ where: { id: user.id }, data: { stripeAccountId: accountId, payoutMode: 'INVOICE' } })
    }
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      refresh_url: `${siteUrl()}/settings?section=paiements&stripe=retry`,
      return_url: `${siteUrl()}/settings?section=paiements&stripe=ok`,
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
