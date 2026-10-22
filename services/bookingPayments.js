// services/bookingPayments.js — Paiement en ligne des bookings (Stripe Connect, « charges séparées »).
//
// Règles validées avec Antho (21/10/2026) :
// - le paiement en ligne est au choix (sinon paiement en direct, hors LS Bookers) ;
// - l'organisateur paie le prix affiché ; la commission (10 % compte gratuit / 5 % Pro, selon le compte
//   de la personne bookée) est retirée de ce qu'elle touche ;
// - carte enregistrée à la confirmation, débit 60 jours avant la date (tout de suite si plus proche) ;
// - 30 % du prix sont acquis à la personne bookée dès le paiement mais bloqués ; tout lui est versé
//   24 h après la prestation, sans intervention de LS Bookers (simple mise en relation) ;
// - annulation par l'organisateur à plus de 7 jours : remboursé, frais bancaires Stripe retenus ;
//   à moins de 7 jours : il perd les 30 % (versés à la personne bookée) et la commission ;
// - annulation par la personne bookée : organisateur remboursé, frais bancaires retenus.
const prisma = require('../prisma/client')
const { getStripe, siteUrl } = require('../lib/stripe')
const { getPlanSettings } = require('../lib/planSettings')
const { isPro } = require('../lib/plan')
const { BillingError, getOrCreateCustomer } = require('./billing')
const { createNotif, displayName } = require('./notifications')
const { notifyAdmins } = require('./adminAlerts')

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const euros = (cents) => (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })

/** Répartition d'un booking payé en ligne (montants en centimes) */
function computeSplit(amountCents, commissionPct, depositPct = 30) {
  const commissionCents = Math.round(amountCents * commissionPct / 100)
  const depositCents = Math.round(amountCents * depositPct / 100)
  return {
    amountCents,
    commissionCents,
    payeeNetCents: amountCents - commissionCents, // versé 24 h après la prestation
    depositCents,                                  // 30 % acquis (bloqués) dès le paiement
  }
}

/**
 * Ce que devient l'argent en cas d'annulation d'un booking déjà payé.
 * Renvoie { refundCents, transferCents, late }.
 */
function cancellationOutcome({ amountCents, commissionCents, depositCents, stripeFeeCents = 0 }, { byPayer, late }) {
  const fee = Math.max(0, stripeFeeCents || 0)
  if (byPayer && late) {
    // L'organisateur perd les 30 % (pour la personne bookée) et la commission
    return { refundCents: Math.max(0, amountCents - depositCents - commissionCents), transferCents: depositCents, late }
  }
  // Annulation à plus de 7 jours, ou par la personne bookée : remboursement moins les frais bancaires
  return { refundCents: Math.max(0, amountCents - fee), transferCents: 0, late }
}

// Fin de la prestation : date de fin, sinon fin de la journée du booking
function prestationEnd(booking) {
  if (booking.endDate) return new Date(booking.endDate)
  const start = new Date(booking.startDate)
  const midnight = start.getUTCHours() === 0 && start.getUTCMinutes() === 0
  return midnight ? new Date(start.getTime() + DAY) : start
}

async function isLateCancellation(booking, now = new Date()) {
  const settings = await getPlanSettings()
  return new Date(booking.startDate).getTime() - now.getTime() < settings.bookingPayment.lateCancelDays * DAY
}

const PERSON = { select: { id: true, userId: true, legalStatus: true, user: { select: { id: true, pseudo: true, firstName: true, lastName: true, role: true, stripeAccountId: true, isPaymentEnabled: true, payoutMode: true } } } }

async function loadBooking(bookingId) {
  return prisma.bookingRequest.findUnique({
    where: { id: Number(bookingId) },
    include: { requester: PERSON, target: PERSON, payment: true },
  })
}

// La personne bookée peut-elle être payée en ligne ?
function payeeEligibility(target) {
  const u = target.user
  if (target.legalStatus === 'INTERMITTENT' || u.payoutMode === 'INTERMITTENT') {
    return { ok: false, code: 'PAYEE_INTERMITTENT', message: "Cette personne est payée en cachet (intermittent du spectacle) : le paiement se fait en direct, avec une déclaration au GUSO par l'organisateur." }
  }
  if (!u.stripeAccountId || !u.isPaymentEnabled) {
    return { ok: false, code: 'PAYEE_NOT_READY', message: "Cette personne n'a pas encore activé les paiements en ligne. Vous pouvez la régler en direct, ou lui demander de les activer dans ses Réglages." }
  }
  return { ok: true }
}

// Résumé affiché sur la fiche du booking
async function paymentSummary(booking, viewerProfileId) {
  const settings = await getPlanSettings()
  const isPayer = viewerProfileId === booking.requesterId
  const isPayee = viewerProfileId === booking.targetId
  const p = booking.payment
  const amountCents = booking.fee ? Math.round(booking.fee * 100) : null
  let commissionPct = p?.commissionPct
  if (commissionPct == null) commissionPct = (await isPro(booking.target.user)) ? settings.commission.proPct : settings.commission.freePct
  const split = amountCents ? computeSplit(p?.amountCents ?? amountCents, commissionPct, p?.depositPct ?? settings.bookingPayment.depositPct) : null
  const eligibility = payeeEligibility(booking.target)
  return {
    mode: booking.paymentMode,
    online: {
      available: !!getStripe(),
      payeeEligible: eligibility.ok,
      reason: eligibility.ok ? null : eligibility.message,
      reasonCode: eligibility.ok ? null : eligibility.code,
    },
    amountCents: split?.amountCents ?? null,
    commissionPct,
    // La commission ne concerne que la personne bookée : l'organisateur ne voit que le prix
    commissionCents: isPayee ? split?.commissionCents ?? null : undefined,
    payeeNetCents: isPayee ? split?.payeeNetCents ?? null : undefined,
    depositCents: split?.depositCents ?? null,
    rules: {
      chargeDaysBefore: settings.bookingPayment.chargeDaysBefore,
      releaseHoursAfter: settings.bookingPayment.releaseHoursAfter,
      lateCancelDays: settings.bookingPayment.lateCancelDays,
      depositPct: settings.bookingPayment.depositPct,
    },
    payment: p ? {
      status: p.status,
      chargeAt: p.chargeAt,
      paidAt: p.paidAt,
      releaseAt: p.status === 'PAID' ? new Date(prestationEnd(booking).getTime() + settings.bookingPayment.releaseHoursAfter * HOUR) : null,
      releasedAt: p.releasedAt,
      refundedCents: p.refundedCents,
      refundedAt: p.refundedAt,
      transferredCents: isPayee ? p.transferredCents : undefined,
      stripeFeeCents: isPayer ? p.stripeFeeCents : undefined,
      failureReason: isPayer ? p.failureReason : undefined,
    } : null,
    role: isPayer ? 'PAYER' : isPayee ? 'PAYEE' : null,
  }
}

/**
 * L'organisateur choisit de payer en ligne : page Stripe pour enregistrer sa carte
 * (débit 60 jours avant la date) ou payer tout de suite si la date est proche.
 */
async function startOnlinePayment({ user, bookingId }) {
  const stripe = getStripe()
  if (!stripe) throw new BillingError('PAYMENTS_UNAVAILABLE', 'Les paiements en ligne ne sont pas encore ouverts.', 503)
  const booking = await loadBooking(bookingId)
  if (!booking) throw new BillingError('BOOKING_NOT_FOUND', 'Booking introuvable.', 404)
  if (booking.requester.userId !== user.id) throw new BillingError('FORBIDDEN', "Seule la personne qui organise le booking peut le payer.", 403)
  if (booking.status !== 'ACCEPTED') throw new BillingError('BOOKING_NOT_ACCEPTED', 'Le booking doit être accepté avant le paiement.')
  if (!booking.fee || booking.fee <= 0) throw new BillingError('NO_FEE', 'Indiquez d’abord le montant du booking.')
  if (prestationEnd(booking) <= new Date()) throw new BillingError('BOOKING_PAST', 'La date de ce booking est passée.')
  if (booking.payment && !['AWAITING_CARD', 'FAILED'].includes(booking.payment.status)) {
    throw new BillingError('ALREADY_PAID', 'Ce booking est déjà réglé en ligne.')
  }
  const eligibility = payeeEligibility(booking.target)
  if (!eligibility.ok) throw new BillingError(eligibility.code, eligibility.message)

  const settings = await getPlanSettings()
  const amountCents = Math.round(booking.fee * 100)
  if (amountCents < 100) throw new BillingError('AMOUNT_TOO_LOW', 'Le montant minimum est de 1 €.')
  const commissionPct = (await isPro(booking.target.user)) ? settings.commission.proPct : settings.commission.freePct
  const split = computeSplit(amountCents, commissionPct, settings.bookingPayment.depositPct)
  const chargeAt = new Date(new Date(booking.startDate).getTime() - settings.bookingPayment.chargeDaysBefore * DAY)
  const payNow = chargeAt <= new Date()
  const customer = await getOrCreateCustomer(stripe, user.id)
  const targetName = displayName(booking.target.user)
  const dateLabel = new Date(booking.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })

  const data = {
    payerId: booking.requesterId, payeeId: booking.targetId, amountCents, commissionPct,
    commissionCents: split.commissionCents, depositPct: settings.bookingPayment.depositPct,
    status: 'AWAITING_CARD', chargeAt: payNow ? new Date() : chargeAt, failureReason: null,
  }
  const payment = await prisma.bookingPayment.upsert({ where: { bookingId: booking.id }, create: { bookingId: booking.id, ...data }, update: data })
  const metadata = { kind: 'booking', bookingId: String(booking.id), paymentId: String(payment.id) }
  const common = {
    customer,
    client_reference_id: String(user.id),
    locale: 'fr',
    metadata,
    success_url: `${siteUrl()}/agenda?booking=${booking.id}&paiement=ok`,
    cancel_url: `${siteUrl()}/agenda?booking=${booking.id}&paiement=annule`,
    custom_text: {
      submit: { message: "LS Bookers met en relation les deux parties et n'intervient pas dans la prestation. Frais bancaires retenus en cas de remboursement." },
    },
  }
  const session = payNow
    ? await stripe.checkout.sessions.create({
      ...common,
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: amountCents, product_data: { name: `Booking de ${targetName} — ${dateLabel}` } } }],
      payment_intent_data: { metadata, transfer_group: `booking_${booking.id}`, setup_future_usage: 'off_session' },
    })
    : await stripe.checkout.sessions.create({
      ...common,
      mode: 'setup',
      currency: 'eur',
      setup_intent_data: { metadata, description: `Booking de ${targetName} — ${dateLabel} : débit de ${euros(amountCents)} le ${chargeAt.toLocaleDateString('fr-FR')}` },
    })
  await prisma.bookingPayment.update({ where: { id: payment.id }, data: { stripeSessionId: session.id } })
  await prisma.bookingRequest.update({ where: { id: booking.id }, data: { paymentMode: 'ONLINE' } })
  return { url: session.url, payNow }
}

// L'organisateur repasse en paiement direct (seulement tant que rien n'a été débité)
async function switchToDirect({ user, bookingId }) {
  const booking = await loadBooking(bookingId)
  if (!booking) throw new BillingError('BOOKING_NOT_FOUND', 'Booking introuvable.', 404)
  if (booking.requester.userId !== user.id) throw new BillingError('FORBIDDEN', 'Non autorisé.', 403)
  if (booking.payment && !['AWAITING_CARD', 'SCHEDULED', 'FAILED'].includes(booking.payment.status)) {
    throw new BillingError('ALREADY_PAID', 'Le paiement en ligne a déjà été débité : annulez le booking pour être remboursé.')
  }
  if (booking.payment) await prisma.bookingPayment.delete({ where: { id: booking.payment.id } })
  return prisma.bookingRequest.update({ where: { id: booking.id }, data: { paymentMode: 'DIRECT' } })
}

async function recordChargeDetails(stripe, paymentId, paymentIntentId) {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge.balance_transaction'] })
  const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null
  const fee = charge?.balance_transaction && typeof charge.balance_transaction === 'object' ? charge.balance_transaction.fee : null
  return prisma.bookingPayment.update({
    where: { id: paymentId },
    data: {
      status: 'PAID', paidAt: new Date(), stripePaymentIntentId: pi.id,
      stripeChargeId: charge?.id || null, stripeFeeCents: fee,
      stripePaymentMethodId: typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id || null,
      failureReason: null,
    },
  })
}

async function notifyPaid(paymentId) {
  const payment = await prisma.bookingPayment.findUnique({ where: { id: paymentId }, include: { booking: { include: { requester: PERSON, target: PERSON } } } })
  if (!payment) return
  const b = payment.booking
  const dateLabel = new Date(b.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
  await createNotif({ userId: b.target.userId, type: 'BOOKING_PAYMENT', content: `Le booking du ${dateLabel} est payé en ligne par ${displayName(b.requester.user)}. Votre part vous sera versée 24 h après la prestation.`, actorId: b.requester.userId })
}

// Fin de la page Stripe (webhook checkout.session.completed)
async function onCheckoutCompleted(session) {
  const stripe = getStripe()
  const paymentId = Number(session.metadata?.paymentId)
  if (!stripe || !paymentId) return
  const payment = await prisma.bookingPayment.findUnique({ where: { id: paymentId } })
  if (!payment || !['AWAITING_CARD', 'FAILED'].includes(payment.status)) return

  if (session.mode === 'payment') {
    const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id
    if (!piId) return
    await recordChargeDetails(stripe, payment.id, piId)
    await notifyPaid(payment.id)
  } else if (session.mode === 'setup') {
    const siId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id
    const si = siId ? await stripe.setupIntents.retrieve(siId) : null
    const pm = typeof si?.payment_method === 'string' ? si.payment_method : si?.payment_method?.id
    await prisma.bookingPayment.update({ where: { id: payment.id }, data: { status: 'SCHEDULED', stripePaymentMethodId: pm || null } })
    const booking = await loadBooking(payment.bookingId)
    if (booking) {
      const when = payment.chargeAt?.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
      await createNotif({ userId: booking.target.userId, type: 'BOOKING_PAYMENT', content: `${displayName(booking.requester.user)} a choisi le paiement en ligne pour votre booking : sa carte sera débitée le ${when}.`, actorId: booking.requester.userId })
    }
  }
}

// Débit automatique des cartes enregistrées dont la date est arrivée (tâche planifiée)
async function chargeDuePayments(now = new Date()) {
  const stripe = getStripe()
  if (!stripe) return 0
  const due = await prisma.bookingPayment.findMany({
    where: { status: 'SCHEDULED', chargeAt: { lte: now } },
    include: { booking: { select: { id: true, status: true, startDate: true, requester: { select: { userId: true, user: { select: { stripeCustomerId: true } } } } } } },
    take: 50,
  })
  let charged = 0
  for (const p of due) {
    if (p.booking.status !== 'ACCEPTED') {
      await prisma.bookingPayment.update({ where: { id: p.id }, data: { status: 'REFUNDED', refundedAt: now, failureReason: 'Booking annulé avant le débit' } })
      continue
    }
    try {
      const pi = await stripe.paymentIntents.create({
        amount: p.amountCents,
        currency: 'eur',
        customer: p.booking.requester.user.stripeCustomerId,
        payment_method: p.stripePaymentMethodId,
        off_session: true,
        confirm: true,
        transfer_group: `booking_${p.bookingId}`,
        metadata: { kind: 'booking', bookingId: String(p.bookingId), paymentId: String(p.id) },
      }, { idempotencyKey: `booking-charge-${p.id}` })
      if (pi.status === 'succeeded') {
        await recordChargeDetails(stripe, p.id, pi.id)
        await notifyPaid(p.id)
        charged++
      } else {
        // La banque demande une validation (3D Secure) : l'organisateur paiera depuis la fiche du booking
        await stripe.paymentIntents.cancel(pi.id).catch(() => {})
        await markFailed(p.id, 'Votre banque demande une validation : payez depuis la fiche du booking.')
      }
    } catch (err) {
      await markFailed(p.id, err.raw?.message || err.message)
    }
  }
  return charged
}

async function markFailed(paymentId, reason) {
  const p = await prisma.bookingPayment.update({ where: { id: paymentId }, data: { status: 'FAILED', failureReason: String(reason || 'Paiement refusé').slice(0, 300) } })
  const booking = await loadBooking(p.bookingId)
  if (!booking) return
  const dateLabel = new Date(booking.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
  await createNotif({ userId: booking.requester.userId, type: 'BOOKING_PAYMENT_FAILED', content: `Le paiement du booking du ${dateLabel} n'a pas pu être débité. Ouvrez le booking pour payer avec une autre carte.` })
  await createNotif({ userId: booking.target.userId, type: 'BOOKING_PAYMENT_FAILED', content: `Le paiement en ligne du booking du ${dateLabel} a échoué : l'organisateur a été prévenu.` })
}

// Versement à la personne bookée 24 h après la prestation (tâche planifiée)
async function releaseDuePayouts(now = new Date()) {
  const stripe = getStripe()
  if (!stripe) return 0
  const settings = await getPlanSettings()
  const paid = await prisma.bookingPayment.findMany({
    where: { status: 'PAID' },
    include: { booking: { include: { requester: PERSON, target: PERSON } } },
    take: 100,
  })
  let released = 0
  for (const p of paid) {
    const b = p.booking
    if (b.status !== 'ACCEPTED' && b.status !== 'COMPLETED') continue
    const releaseAt = new Date(prestationEnd(b).getTime() + settings.bookingPayment.releaseHoursAfter * HOUR)
    if (releaseAt > now) continue
    const amount = p.amountCents - p.commissionCents - p.transferredCents
    try {
      const transfer = amount > 0 ? await stripe.transfers.create({
        amount,
        currency: 'eur',
        destination: b.target.user.stripeAccountId,
        transfer_group: `booking_${b.id}`,
        ...(p.stripeChargeId ? { source_transaction: p.stripeChargeId } : {}),
        metadata: { kind: 'booking_payout', bookingId: String(b.id), paymentId: String(p.id) },
      }, { idempotencyKey: `booking-release-${p.id}` }) : null
      await prisma.bookingPayment.update({
        where: { id: p.id },
        data: { status: 'RELEASED', releasedAt: now, transferId: transfer?.id || p.transferId, transferredCents: p.transferredCents + Math.max(0, amount) },
      })
      const dateLabel = new Date(b.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
      await createNotif({ userId: b.target.userId, type: 'PAYOUT_RELEASED', content: `${euros(Math.max(0, amount))} pour le booking du ${dateLabel} ont été versés sur votre compte de paiement.` })
      released++
    } catch (err) {
      console.error(`Versement booking ${b.id} impossible :`, err.message)
    }
  }
  return released
}

/**
 * Annulation d'un booking accepté : remboursement / versement selon qui annule et quand,
 * puis comptage des annulations tardives de la personne bookée.
 */
async function onBookingCancelled(bookingId, cancelledByProfileId, now = new Date()) {
  const booking = await loadBooking(bookingId)
  if (!booking) return null
  const late = await isLateCancellation(booking, now)
  const byPayer = cancelledByProfileId === booking.requesterId
  await prisma.bookingRequest.update({
    where: { id: booking.id },
    data: { cancelledAt: now, cancelledById: cancelledByProfileId, lateCancellation: late },
  })

  const p = booking.payment
  let outcome = null
  if (p && ['AWAITING_CARD', 'SCHEDULED', 'FAILED'].includes(p.status)) {
    // Rien n'a été débité
    await prisma.bookingPayment.update({ where: { id: p.id }, data: { status: 'REFUNDED', refundedAt: now, failureReason: 'Booking annulé avant le débit' } })
  } else if (p && p.status === 'PAID') {
    const stripe = getStripe()
    outcome = cancellationOutcome({
      amountCents: p.amountCents, commissionCents: p.commissionCents,
      depositCents: Math.round(p.amountCents * p.depositPct / 100), stripeFeeCents: p.stripeFeeCents || 0,
    }, { byPayer, late })
    if (stripe) {
      try {
        if (outcome.refundCents > 0) {
          await stripe.refunds.create({ payment_intent: p.stripePaymentIntentId, amount: outcome.refundCents, metadata: { kind: 'booking', bookingId: String(booking.id) } }, { idempotencyKey: `booking-refund-${p.id}` })
        }
        let transferId = null
        if (outcome.transferCents > 0) {
          const t = await stripe.transfers.create({
            amount: outcome.transferCents, currency: 'eur', destination: booking.target.user.stripeAccountId,
            transfer_group: `booking_${booking.id}`, ...(p.stripeChargeId ? { source_transaction: p.stripeChargeId } : {}),
            metadata: { kind: 'booking_late_cancel', bookingId: String(booking.id) },
          }, { idempotencyKey: `booking-latecancel-${p.id}` })
          transferId = t.id
        }
        await prisma.bookingPayment.update({
          where: { id: p.id },
          data: {
            status: outcome.transferCents > 0 ? 'PARTIAL_REFUND' : 'REFUNDED',
            refundedCents: outcome.refundCents, refundedAt: now,
            transferredCents: p.transferredCents + outcome.transferCents, transferId: transferId || p.transferId,
          },
        })
      } catch (err) {
        console.error(`Remboursement booking ${booking.id} impossible :`, err.message)
        await notifyAdmins({ type: 'ADMIN_PAYMENT_ISSUE', content: `Remboursement automatique impossible pour le booking n° ${booking.id} : à vérifier dans Stripe.` })
      }
    }
    const dateLabel = new Date(booking.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
    await createNotif({ userId: booking.requester.userId, type: 'BOOKING_PAYMENT', content: `Booking du ${dateLabel} annulé : ${euros(outcome.refundCents)} vous sont remboursés${outcome.transferCents ? ` (${euros(outcome.transferCents)} versés à ${displayName(booking.target.user)} pour l'annulation tardive)` : ' (frais bancaires retenus)'}.` })
    if (outcome.transferCents) {
      await createNotif({ userId: booking.target.userId, type: 'PAYOUT_RELEASED', content: `Annulation tardive du booking du ${dateLabel} : ${euros(outcome.transferCents)} vous sont versés.` })
    }
  }

  if (!byPayer && late) await countLateCancellation(booking.target)
  return { late, byPayer, outcome }
}

// Annulations tardives de la personne bookée : avertissement, puis alerte de l'admin (qui décide du bannissement)
async function countLateCancellation(target) {
  const settings = await getPlanSettings()
  const since = new Date(Date.now() - settings.lateCancellations.windowDays * DAY)
  const count = await prisma.bookingRequest.count({
    where: { targetId: target.id, cancelledById: target.id, lateCancellation: true, cancelledAt: { gte: since } },
  })
  if (count >= settings.lateCancellations.alertAt) {
    await notifyAdmins({ type: 'ADMIN_LATE_CANCEL_ALERT', content: `${displayName(target.user)} a annulé ${count} bookings à moins de 7 jours en un an. À examiner dans l'admin (Annulations).`, actorId: target.userId })
  } else if (count >= settings.lateCancellations.warnAt) {
    await prisma.user.update({ where: { id: target.userId }, data: { lateCancelWarnedAt: new Date() } })
    await createNotif({ userId: target.userId, type: 'LATE_CANCEL_WARNING', content: `Attention : vous avez annulé ${count} bookings à moins de 7 jours de la date cette année. À ${settings.lateCancellations.alertAt}, votre compte peut être suspendu.` })
  }
  return count
}

// Contestation bancaire : la décision de la banque s'applique, la somme est reprise à la personne bookée
async function onDispute(dispute) {
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id
  if (!chargeId) return
  const p = await prisma.bookingPayment.findFirst({ where: { stripeChargeId: chargeId } })
  if (!p) return
  const stripe = getStripe()
  if (stripe && p.transferId && p.transferredCents > 0) {
    await stripe.transfers.createReversal(p.transferId, { metadata: { reason: 'dispute', disputeId: dispute.id } })
      .catch(err => console.error('Reprise du versement impossible :', err.message))
  }
  await prisma.bookingPayment.update({ where: { id: p.id }, data: { status: 'DISPUTED' } })
  await notifyAdmins({ type: 'ADMIN_PAYMENT_ISSUE', content: `Contestation bancaire sur le booking n° ${p.bookingId} : voir Stripe.` })
}

// Attestation de paiement (pas une facture : LS Bookers n'est pas partie au contrat)
async function paymentAttestation(bookingId, viewerProfileId) {
  const booking = await prisma.bookingRequest.findUnique({
    where: { id: Number(bookingId) },
    include: { payment: true, requester: { include: { user: true } }, target: { include: { user: true } } },
  })
  if (!booking || !booking.payment) return null
  if (![booking.requesterId, booking.targetId].includes(viewerProfileId)) return null
  const p = booking.payment
  if (!['PAID', 'RELEASED', 'PARTIAL_REFUND', 'REFUNDED'].includes(p.status) || !p.paidAt) return null
  const isPayee = viewerProfileId === booking.targetId
  return {
    reference: `LSB-PAY-${String(p.id).padStart(6, '0')}`,
    bookingId: booking.id,
    date: booking.startDate,
    paidAt: p.paidAt,
    payer: displayName(booking.requester.user),
    payee: displayName(booking.target.user),
    amountCents: p.amountCents,
    commissionCents: isPayee ? p.commissionCents : undefined,
    commissionPct: isPayee ? p.commissionPct : undefined,
    transferredCents: isPayee ? p.transferredCents : undefined,
    refundedCents: p.refundedCents,
    status: p.status,
  }
}

module.exports = {
  computeSplit, cancellationOutcome, prestationEnd, payeeEligibility, paymentSummary, startOnlinePayment, switchToDirect,
  onCheckoutCompleted, chargeDuePayments, releaseDuePayouts, onBookingCancelled, countLateCancellation, onDispute,
  paymentAttestation, markFailed, isLateCancellation,
}
