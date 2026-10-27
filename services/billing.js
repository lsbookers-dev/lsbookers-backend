// services/billing.js — Abonnement Pro (Stripe Billing) et codes promo.
// Le site n'enregistre jamais de carte : Stripe s'en charge sur sa propre page de paiement.
const prisma = require('../prisma/client')
const { getStripe, siteUrl } = require('../lib/stripe')
const { getPlanSettings } = require('../lib/planSettings')
const { isProSubscription } = require('../lib/plan')

const ROLE_LABELS = { ARTIST: 'Artiste', PROVIDER: 'Prestataire', ORGANIZER: 'Organisateur' }
const normalizeCode = (code) => String(code || '').trim().toUpperCase().replace(/\s+/g, '')

class BillingError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}

// Client Stripe du membre (créé une fois, réutilisé pour l'abonnement et les paiements de bookings)
async function getOrCreateCustomer(stripe, userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, pseudo: true, firstName: true, lastName: true, stripeCustomerId: true },
  })
  if (!user) throw new BillingError('USER_NOT_FOUND', 'Compte introuvable', 404)
  if (user.stripeCustomerId) return user.stripeCustomerId
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.pseudo || undefined
  const customer = await stripe.customers.create({ email: user.email, name, metadata: { userId: String(user.id) } })
  await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customer.id } })
  return customer.id
}

async function priceFor(role, interval) {
  const settings = await getPlanSettings()
  const prices = settings.prices?.[role]
  if (!prices) throw new BillingError('ROLE_NOT_ELIGIBLE', "L'abonnement Pro n'existe pas pour ce type de compte.")
  return interval === 'YEAR' ? prices.yearCents : prices.monthCents
}

// Vérifie un code promo pour ce membre. Renvoie le code ou lance une BillingError.
async function checkPromoCode(rawCode, userId, expectedKind) {
  const code = normalizeCode(rawCode)
  if (!code) throw new BillingError('PROMO_INVALID', 'Code promo invalide.')
  const promo = await prisma.promoCode.findUnique({ where: { code } })
  if (!promo || !promo.active) throw new BillingError('PROMO_INVALID', 'Ce code promo n’existe pas ou n’est plus actif.')
  if (expectedKind && promo.kind !== expectedKind) {
    throw new BillingError('PROMO_WRONG_KIND', promo.kind === 'FOUNDER'
      ? 'Ce code Fondateur s’utilise avec le bouton « J’ai un code Fondateur ».'
      : 'Ce code ne peut pas être utilisé ici.')
  }
  if (promo.reservedUserId && promo.reservedUserId !== userId) throw new BillingError('PROMO_RESERVED', 'Ce code est réservé à un autre membre.')
  if (promo.expiresAt && promo.expiresAt <= new Date()) throw new BillingError('PROMO_EXPIRED', 'Ce code promo a expiré.')
  if (promo.maxUses != null && promo.usedCount >= promo.maxUses) throw new BillingError('PROMO_USED', 'Ce code promo a déjà été utilisé.')
  const already = await prisma.promoRedemption.findUnique({ where: { codeId_userId: { codeId: promo.id, userId } } })
  if (already) throw new BillingError('PROMO_ALREADY_USED', 'Vous avez déjà utilisé ce code.')
  return promo
}

// Marque un code comme utilisé par ce membre (sans dépasser le nombre d'utilisations prévu)
async function redeemPromoCode(promoId, userId) {
  const already = await prisma.promoRedemption.findUnique({ where: { codeId_userId: { codeId: promoId, userId } } })
  if (already) return true
  const updated = await prisma.$executeRaw`UPDATE "PromoCode" SET "usedCount" = "usedCount" + 1
    WHERE "id" = ${promoId} AND "active" = true AND ("maxUses" IS NULL OR "usedCount" < "maxUses")`
  if (!updated) return false
  await prisma.promoRedemption.create({ data: { codeId: promoId, userId } })
  return true
}

const addMonths = (date, months) => { const d = new Date(date); d.setMonth(d.getMonth() + months); return d }

/**
 * Page de paiement Stripe pour passer en Pro.
 * Carte demandée tout de suite ; prélèvement à la fin de l'essai (1 mois), ou des mois offerts
 * par un code Lancement (qui remplacent l'essai).
 */
async function createSubscriptionCheckout({ user, interval, promoCode, plan = 'PRO' }) {
  const stripe = getStripe()
  if (!stripe) throw new BillingError('PAYMENTS_UNAVAILABLE', 'Les paiements en ligne ne sont pas encore ouverts.', 503)
  if (!['MONTH', 'YEAR'].includes(interval)) throw new BillingError('INTERVAL_INVALID', 'Formule invalide.')
  const role = String(user.role || '').toUpperCase()
  if (!ROLE_LABELS[role]) throw new BillingError('ROLE_NOT_ELIGIBLE', "L'abonnement Pro n'existe pas pour ce type de compte.")
  if (plan === 'AGENCY') return createAgencyCheckout({ stripe, user, interval, promoCode })

  const existing = await prisma.subscription.findUnique({ where: { userId: user.id } })
  const agencySub = await prisma.agencySubscription.findUnique({ where: { userId: user.id } })
  if (isProSubscription(agencySub)) throw new BillingError('ALREADY_AGENCY', 'Votre formule Business comprend déjà le Pro.')
  if (isProSubscription(existing) && existing.source !== 'STRIPE') {
    throw new BillingError('ALREADY_PRO', 'Votre compte Pro vous est déjà offert.')
  }
  if (isProSubscription(existing) && existing.status !== 'CANCELLED') {
    throw new BillingError('ALREADY_PRO', 'Vous êtes déjà abonné. Gérez votre abonnement depuis cette page.')
  }

  const settings = await getPlanSettings()
  const unitAmount = await priceFor(role, interval)
  const customer = await getOrCreateCustomer(stripe, user.id)

  // Essai d'un mois une seule fois par compte ; un code Lancement le remplace par ses mois offerts
  let promo = null
  if (promoCode) promo = await checkPromoCode(promoCode, user.id, 'LAUNCH')
  const hadTrial = !!(existing && (existing.trialEndsAt || existing.stripeSubId))
  const subscriptionData = { metadata: { userId: String(user.id), promoCodeId: promo ? String(promo.id) : '' } }
  if (promo?.freeMonths) {
    subscriptionData.trial_end = Math.floor(addMonths(new Date(), promo.freeMonths).getTime() / 1000)
  } else if (!hadTrial && settings.trialDays > 0) {
    subscriptionData.trial_period_days = settings.trialDays
  }
  if (subscriptionData.trial_end || subscriptionData.trial_period_days) {
    // Sans carte valable à la fin de l'essai : retour automatique au compte gratuit
    subscriptionData.trial_settings = { end_behavior: { missing_payment_method: 'cancel' } }
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: String(user.id),
    locale: 'fr',
    payment_method_collection: 'always',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'eur',
        unit_amount: unitAmount,
        recurring: { interval: interval === 'YEAR' ? 'year' : 'month' },
        product_data: { name: `LS Bookers Pro — ${ROLE_LABELS[role]}` },
      },
    }],
    subscription_data: subscriptionData,
    metadata: { kind: 'subscription', userId: String(user.id), promoCodeId: promo ? String(promo.id) : '' },
    success_url: `${siteUrl()}/subscriptions?abonnement=ok`,
    cancel_url: `${siteUrl()}/subscriptions?abonnement=annule`,
  })
  return { url: session.url }
}

/**
 * Page de paiement Stripe pour la formule Agence.
 * Un abonné Pro (payant) qui passe à l'Agence : son abonnement Pro est arrêté quand l'Agence
 * démarre, et Stripe déduit la partie non utilisée de la prochaine facture (voir syncAgencySubscription).
 * Un Pro offert (Fondateur, admin) n'est pas touché : il le retrouve si l'Agence s'arrête.
 */
async function createAgencyCheckout({ stripe, user, interval, promoCode }) {
  const existing = await prisma.agencySubscription.findUnique({ where: { userId: user.id } })
  if (isProSubscription(existing) && existing.status !== 'CANCELLED') {
    throw new BillingError('ALREADY_AGENCY', 'Vous avez déjà la formule Business. Gérez-la depuis cette page.')
  }
  const settings = await getPlanSettings()
  const unitAmount = interval === 'YEAR' ? settings.agency.yearCents : settings.agency.monthCents
  const customer = await getOrCreateCustomer(stripe, user.id)

  let promo = null
  if (promoCode) promo = await checkPromoCode(promoCode, user.id, 'LAUNCH')
  const metadata = { userId: String(user.id), plan: 'AGENCY', promoCodeId: promo ? String(promo.id) : '' }
  const subscriptionData = { metadata }
  if (promo?.freeMonths) {
    subscriptionData.trial_end = Math.floor(addMonths(new Date(), promo.freeMonths).getTime() / 1000)
    subscriptionData.trial_settings = { end_behavior: { missing_payment_method: 'cancel' } }
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: String(user.id),
    locale: 'fr',
    payment_method_collection: 'always',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'eur',
        unit_amount: unitAmount,
        recurring: { interval: interval === 'YEAR' ? 'year' : 'month' },
        product_data: { name: `LS Bookers Business — ${settings.agency.includedProfiles} profils inclus` },
      },
    }],
    subscription_data: subscriptionData,
    metadata: { kind: 'subscription', ...metadata },
    success_url: `${siteUrl()}/subscriptions?business=ok`,
    cancel_url: `${siteUrl()}/subscriptions?abonnement=annule`,
  })
  return { url: session.url }
}

// Recopie un abonnement Stripe « formule Agence » dans AgencySubscription (appelé par les webhooks)
async function syncAgencySubscription(stripeSub, userId) {
  const status = STRIPE_STATUS[stripeSub.status]
  if (!status) return null
  const existing = await prisma.agencySubscription.findUnique({ where: { userId } })
  // Un ancien abonnement Agence ne remplace pas un plus récent
  if (existing?.stripeSubId && existing.stripeSubId !== stripeSub.id && isProSubscription(existing) && status === 'CANCELLED') return existing

  const items = stripeSub.items?.data || []
  const extraItem = items.find(i => i.id === existing?.stripeExtraItemId) || null
  const base = items.find(i => i !== extraItem) || items[0]
  const periodEnd = base?.current_period_end ?? stripeSub.current_period_end
  const data = {
    status,
    interval: base?.price?.recurring?.interval === 'year' ? 'YEAR' : 'MONTH',
    priceCents: base?.price?.unit_amount ?? 0,
    stripeSubId: stripeSub.id,
    trialEndsAt: toDate(stripeSub.trial_end),
    currentPeriodEnd: toDate(periodEnd),
    cancelAtPeriodEnd: !!stripeSub.cancel_at_period_end,
    endDate: status === 'EXPIRED' ? new Date() : (status === 'CANCELLED' ? (toDate(stripeSub.ended_at) || new Date()) : null),
    ...(existing && existing.stripeSubId !== stripeSub.id ? { stripeExtraItemId: null, extraProfiles: 0 } : {}),
  }
  const promoCodeId = Number(stripeSub.metadata?.promoCodeId)
  if (promoCodeId) {
    const promo = await prisma.promoCode.findUnique({ where: { id: promoCodeId }, select: { code: true } })
    if (promo) data.promoCode = promo.code
  }
  const saved = await prisma.agencySubscription.upsert({
    where: { userId },
    create: { userId, startDate: toDate(stripeSub.start_date) || new Date(), ...data },
    update: data,
  })

  if (status === 'TRIAL' || status === 'ACTIVE') {
    await prisma.user.update({ where: { id: userId }, data: { signupPlan: null } }).catch(() => {})
    // Abonné Pro payant passé à l'Agence : le Pro s'arrête, la partie non utilisée est déduite
    const pro = await prisma.subscription.findUnique({ where: { userId } })
    if (pro?.source === 'STRIPE' && pro.stripeSubId && isProSubscription(pro) && pro.status !== 'CANCELLED') {
      const stripe = getStripe()
      if (stripe) {
        await stripe.subscriptions.cancel(pro.stripeSubId, { prorate: true, invoice_now: true })
          .catch(err => console.error('Agence : arrêt du Pro remplacé', err.message))
      }
    }
  }
  // Ses artistes : Pro suspendu ou relancé selon que la formule est en cours
  await require('./agency').onAgencyChanged(userId)
  return saved
}

// Code Fondateur : Pro offert à vie, sans carte
async function applyFounderCode({ user, code }) {
  const promo = await checkPromoCode(code, user.id, 'FOUNDER')
  const existing = await prisma.subscription.findUnique({ where: { userId: user.id } })

  // Un abonnement payant en cours est arrêté tout de suite : le Pro est désormais offert
  if (existing?.stripeSubId && isProSubscription(existing) && existing.status !== 'CANCELLED') {
    const stripe = getStripe()
    if (stripe) await stripe.subscriptions.cancel(existing.stripeSubId).catch(err => console.error('Fondateur : arrêt abonnement Stripe', err.message))
  }

  const ok = await redeemPromoCode(promo.id, user.id)
  if (!ok) throw new BillingError('PROMO_USED', 'Ce code promo a déjà été utilisé.')

  const data = {
    status: 'ACTIVE', plan: 'PRO', interval: 'LIFETIME', source: 'FOUNDER', priceCents: 0,
    stripeSubId: null, promoCode: promo.code, trialEndsAt: null, currentPeriodEnd: null,
    cancelAtPeriodEnd: false, endDate: null, startDate: new Date(),
  }
  await prisma.user.update({ where: { id: user.id }, data: { signupPlan: null } }).catch(() => {})
  return prisma.subscription.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data })
}

const STRIPE_STATUS = {
  trialing: 'TRIAL', active: 'ACTIVE', past_due: 'PAST_DUE', unpaid: 'PAST_DUE',
  canceled: 'CANCELLED', incomplete_expired: 'EXPIRED', paused: 'EXPIRED',
}
const toDate = (sec) => (sec ? new Date(sec * 1000) : null)

// Recopie un abonnement Stripe dans la table Subscription (appelé par les webhooks)
async function syncStripeSubscription(stripeSub) {
  const userId = Number(stripeSub.metadata?.userId)
  if (!userId) {
    console.warn('Abonnement Stripe sans userId :', stripeSub.id)
    return null
  }
  if (stripeSub.metadata?.plan === 'AGENCY') return syncAgencySubscription(stripeSub, userId)
  const status = STRIPE_STATUS[stripeSub.status]
  if (!status) return null // incomplete : paiement pas encore fait

  const existing = await prisma.subscription.findUnique({ where: { userId } })
  // Un Pro offert (Fondateur / admin) n'est jamais écrasé par un ancien abonnement Stripe
  if (existing && existing.source !== 'STRIPE' && isProSubscription(existing)) return existing
  // Un ancien abonnement Stripe ne remplace pas un plus récent
  if (existing?.stripeSubId && existing.stripeSubId !== stripeSub.id && isProSubscription(existing) && status === 'CANCELLED') return existing

  const item = stripeSub.items?.data?.[0]
  const recurring = item?.price?.recurring
  const periodEnd = item?.current_period_end ?? stripeSub.current_period_end
  const data = {
    status,
    plan: 'PRO',
    source: 'STRIPE',
    interval: recurring?.interval === 'year' ? 'YEAR' : 'MONTH',
    priceCents: item?.price?.unit_amount ?? 0,
    stripeSubId: stripeSub.id,
    trialEndsAt: toDate(stripeSub.trial_end),
    currentPeriodEnd: toDate(periodEnd),
    cancelAtPeriodEnd: !!stripeSub.cancel_at_period_end,
    endDate: status === 'EXPIRED' ? new Date() : (status === 'CANCELLED' ? toDate(stripeSub.ended_at) : null),
  }
  const promoCodeId = Number(stripeSub.metadata?.promoCodeId)
  if (promoCodeId) {
    const promo = await prisma.promoCode.findUnique({ where: { id: promoCodeId }, select: { code: true } })
    if (promo) data.promoCode = promo.code
  }
  if (status === 'TRIAL' || status === 'ACTIVE') {
    await prisma.user.update({ where: { id: userId }, data: { signupPlan: null } }).catch(() => {})
  }
  return prisma.subscription.upsert({
    where: { userId },
    create: { userId, startDate: toDate(stripeSub.start_date) || new Date(), ...data },
    update: data,
  })
}

// Espace client Stripe : changer de carte, de formule, résilier, télécharger les factures
async function createPortalSession(user) {
  const stripe = getStripe()
  if (!stripe) throw new BillingError('PAYMENTS_UNAVAILABLE', 'Les paiements en ligne ne sont pas encore ouverts.', 503)
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { stripeCustomerId: true } })
  if (!row?.stripeCustomerId) throw new BillingError('NO_CUSTOMER', 'Aucun abonnement à gérer.')
  const session = await stripe.billingPortal.sessions.create({
    customer: row.stripeCustomerId,
    locale: 'fr',
    return_url: `${siteUrl()}/subscriptions`,
  })
  return { url: session.url }
}

module.exports = {
  syncAgencySubscription, createAgencyCheckout,
  BillingError, ROLE_LABELS, normalizeCode, getOrCreateCustomer, priceFor, checkPromoCode, redeemPromoCode,
  createSubscriptionCheckout, applyFounderCode, syncStripeSubscription, createPortalSession,
}
