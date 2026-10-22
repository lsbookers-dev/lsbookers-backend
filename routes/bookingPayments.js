// routes/bookingPayments.js — Paiement d'un booking : en direct ou en ligne (Stripe)
const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const payments = require('../services/bookingPayments')
const { sendError } = require('./billing')

async function myProfileId(userId) {
  const p = await prisma.profile.findUnique({ where: { userId }, select: { id: true } })
  return p?.id ?? null
}

// GET /api/booking-payments/:bookingId — résumé du paiement pour l'organisateur ou la personne bookée
router.get('/:bookingId(\\d+)', requireAuth, async (req, res) => {
  try {
    const profileId = await myProfileId(req.user.id)
    const booking = await prisma.bookingRequest.findUnique({
      where: { id: Number(req.params.bookingId) },
      include: {
        payment: true,
        target: { select: { id: true, userId: true, legalStatus: true, user: { select: { id: true, role: true, stripeAccountId: true, isPaymentEnabled: true, payoutMode: true, pseudo: true, firstName: true, lastName: true } } } },
      },
    })
    if (!booking || ![booking.requesterId, booking.targetId].includes(profileId)) return res.status(404).json({ error: 'Booking introuvable' })
    res.json(await payments.paymentSummary(booking, profileId))
  } catch (err) {
    sendError(res, err, 'GET /booking-payments/:id')
  }
})

// POST /api/booking-payments/:bookingId/online — payer en ligne (page Stripe)
router.post('/:bookingId(\\d+)/online', requireAuth, async (req, res) => {
  try {
    res.json(await payments.startOnlinePayment({ user: req.user, bookingId: req.params.bookingId }))
  } catch (err) {
    sendError(res, err, 'POST /booking-payments/:id/online')
  }
})

// POST /api/booking-payments/:bookingId/direct — revenir au paiement en direct
router.post('/:bookingId(\\d+)/direct', requireAuth, async (req, res) => {
  try {
    await payments.switchToDirect({ user: req.user, bookingId: req.params.bookingId })
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err, 'POST /booking-payments/:id/direct')
  }
})

// GET /api/booking-payments/:bookingId/attestation — attestation de paiement LS Bookers
router.get('/:bookingId(\\d+)/attestation', requireAuth, async (req, res) => {
  try {
    const att = await payments.paymentAttestation(req.params.bookingId, await myProfileId(req.user.id))
    if (!att) return res.status(404).json({ error: 'Attestation indisponible' })
    res.json({ attestation: att })
  } catch (err) {
    sendError(res, err, 'GET /booking-payments/:id/attestation')
  }
})

module.exports = router
