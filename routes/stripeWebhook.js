// routes/stripeWebhook.js — Messages envoyés par Stripe (paiement terminé, abonnement modifié…).
// Monté AVANT express.json() : la signature Stripe se vérifie sur le corps brut.
const express = require('express')
const prisma = require('../prisma/client')
const { getStripe } = require('../lib/stripe')
const billing = require('../services/billing')
const extras = require('../services/extras')
const bookingPayments = require('../services/bookingPayments')

async function handleEvent(stripe, event) {
  const obj = event.data.object
  switch (event.type) {
    case 'checkout.session.completed': {
      const kind = obj.metadata?.kind
      if (kind === 'subscription' && obj.subscription) {
        const sub = await stripe.subscriptions.retrieve(typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id)
        await billing.syncStripeSubscription(sub)
        const promoCodeId = Number(obj.metadata?.promoCodeId)
        if (promoCodeId) await billing.redeemPromoCode(promoCodeId, Number(obj.metadata.userId))
      } else if (kind === 'extra' && obj.payment_status === 'paid') {
        await extras.markOrderPaid(obj)
      } else if (kind === 'booking') {
        await bookingPayments.onCheckoutCompleted(obj)
      }
      break
    }
    case 'checkout.session.expired': {
      if (obj.metadata?.kind === 'extra' && obj.metadata.orderId) {
        await prisma.extraOrder.updateMany({ where: { id: Number(obj.metadata.orderId), status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } })
      }
      break
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await billing.syncStripeSubscription(obj)
      break
    case 'payment_intent.payment_failed': {
      if (obj.metadata?.kind === 'booking' && obj.metadata.paymentId) {
        const p = await prisma.bookingPayment.findUnique({ where: { id: Number(obj.metadata.paymentId) } })
        if (p && p.status === 'SCHEDULED') await bookingPayments.markFailed(p.id, obj.last_payment_error?.message)
      }
      break
    }
    case 'charge.dispute.created':
      await bookingPayments.onDispute(obj)
      break
    case 'account.updated': {
      const ready = !!(obj.details_submitted && obj.payouts_enabled && obj.capabilities?.transfers === 'active')
      await prisma.user.updateMany({ where: { stripeAccountId: obj.id }, data: { isPaymentEnabled: ready, isIdentityVerified: ready } })
      break
    }
    default:
      break
  }
}

const router = express.Router()

router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const stripe = getStripe()
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!stripe || !secret) return res.status(503).json({ error: 'Stripe non configuré' })
  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret)
  } catch (err) {
    console.warn('Webhook Stripe : signature invalide', err.message)
    return res.status(400).json({ error: 'Signature invalide' })
  }
  try {
    await handleEvent(stripe, event)
    res.json({ received: true })
  } catch (err) {
    // Stripe renverra le message plus tard : chaque traitement est fait pour supporter les répétitions
    console.error(`Webhook Stripe ${event.type} :`, err)
    res.status(500).json({ error: 'Traitement impossible' })
  }
})

module.exports = router
module.exports.handleEvent = handleEvent
