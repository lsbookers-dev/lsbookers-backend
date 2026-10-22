// services/extras.js — Formules supplémentaires (carrousel régional ou national, newsletter,
// réseaux sociaux, …) achetées depuis la page « Offres et abonnements », validées par l'admin.
const prisma = require('../prisma/client')
const { getStripe, siteUrl } = require('../lib/stripe')
const { getPlanSettings } = require('../lib/planSettings')
const { ensureProfileRegion, regionName } = require('../lib/regions')
const { BillingError, getOrCreateCustomer } = require('./billing')
const { notifyAdmins } = require('./adminAlerts')
const { createNotif } = require('./notifications')

const DAY = 24 * 60 * 60 * 1000
const KINDS = ['CAROUSEL', 'NEWSLETTER', 'SOCIAL', 'OTHER']
const SCOPES = ['REGIONAL', 'NATIONAL']

// Catalogue de départ (inactif) : Antho fixe les prix et active chaque formule depuis l'admin
const DEFAULT_OFFERS = [
  {
    kind: 'CAROUSEL', position: 0, active: false,
    title: 'Mise en avant dans le carrousel',
    description: "Votre profil apparaît en tête de la page d'accueil, auprès des membres de votre région ou de toute la France.",
    options: [
      { id: 'reg-7', label: 'Régional · 7 jours', scope: 'REGIONAL', days: 7, priceCents: 1500 },
      { id: 'reg-30', label: 'Régional · 30 jours', scope: 'REGIONAL', days: 30, priceCents: 4000 },
      { id: 'nat-7', label: 'National · 7 jours', scope: 'NATIONAL', days: 7, priceCents: 4000 },
      { id: 'nat-30', label: 'National · 30 jours', scope: 'NATIONAL', days: 30, priceCents: 12000 },
    ],
  },
  {
    kind: 'NEWSLETTER', position: 1, active: false,
    title: 'Newsletter régionale',
    description: "Votre profil présenté par e-mail aux membres de votre région qui ont accepté de recevoir les suggestions de LS Bookers.",
    options: [{ id: 'news-1', label: '1 envoi', scope: 'REGIONAL', priceCents: 3000 }],
  },
  {
    kind: 'SOCIAL', position: 2, active: false,
    title: 'Mise en avant sur nos réseaux sociaux',
    description: 'Une publication dédiée à votre profil sur les réseaux sociaux de LS Bookers.',
    options: [{ id: 'social-1', label: '1 publication', priceCents: 2000 }],
  },
]

async function ensureDefaultOffers() {
  const count = await prisma.extraOffer.count()
  if (count === 0) await prisma.extraOffer.createMany({ data: DEFAULT_OFFERS })
}

// Nettoie les options envoyées par l'admin
function sanitizeOptions(kind, options) {
  if (!Array.isArray(options)) throw new BillingError('OPTIONS_INVALID', 'Options invalides.')
  const seen = new Set()
  return options.slice(0, 20).map((o, i) => {
    const priceCents = Math.round(Number(o?.priceCents))
    const days = o?.days == null || o.days === '' ? null : Math.round(Number(o.days))
    const scope = SCOPES.includes(o?.scope) ? o.scope : null
    const label = String(o?.label || '').trim().slice(0, 80)
    let id = String(o?.id || '').trim().slice(0, 40) || `opt-${Date.now().toString(36)}-${i}`
    if (seen.has(id)) id = `${id}-${i}`
    seen.add(id)
    if (!label) throw new BillingError('OPTIONS_INVALID', 'Chaque option doit avoir un nom.')
    if (!Number.isFinite(priceCents) || priceCents < 100) throw new BillingError('OPTIONS_INVALID', 'Chaque option doit coûter au moins 1 €.')
    if (kind === 'CAROUSEL' && (!scope || !Number.isFinite(days) || days < 1)) {
      throw new BillingError('OPTIONS_INVALID', 'Chaque option du carrousel doit préciser régional ou national et une durée en jours.')
    }
    return { id, label, priceCents, days: Number.isFinite(days) ? days : null, scope }
  })
}

// Mises en avant payantes qui occupent une place (affichées ou à venir) dans une zone
async function carouselOccupancy(scope, regionCode) {
  const now = new Date()
  const zone = scope === 'REGIONAL' ? { scope, regionCode } : { scope }
  const [live, waiting] = await Promise.all([
    prisma.homeFeatured.findMany({ where: { ...zone, OR: [{ endsAt: null }, { endsAt: { gt: now } }] }, select: { startsAt: true, endsAt: true } }),
    // Payées mais pas encore validées par l'admin : la place est réservée
    prisma.extraOrder.findMany({ where: { kind: 'CAROUSEL', status: 'PAID', ...zone }, select: { desiredStart: true, days: true, paidAt: true } }),
  ])
  return [
    // Sans date de début : la place est occupée dès maintenant
    ...live.map(f => ({ start: f.startsAt || new Date(0), end: f.endsAt })),
    ...waiting.map(o => {
      const start = o.desiredStart && o.desiredStart > now ? o.desiredStart : now
      return { start: o.desiredStart && o.desiredStart > now ? start : new Date(0), end: new Date(start.getTime() + (o.days || 7) * DAY) }
    }),
  ]
}

/**
 * Disponibilité d'une zone du carrousel : pleine ou non à une date, et première date libre.
 * Places : 12 par région (régional) et 10 pour toute la France (national), réglables dans l'admin.
 */
async function carouselAvailability(scope, regionCode, from = new Date()) {
  const settings = await getPlanSettings()
  const slots = scope === 'REGIONAL' ? settings.carousel.regionalSlots : settings.carousel.nationalSlots
  const spans = await carouselOccupancy(scope, regionCode)
  const busyAt = (date) => spans.filter(s => s.start <= date && (!s.end || s.end > date)).length
  const usedNow = busyAt(from)
  if (usedNow < slots) return { slots, used: usedNow, full: false, nextFreeDate: from }
  // Première date où une place se libère
  const ends = spans.map(s => s.end).filter(e => e && e > from).sort((a, b) => a - b)
  const nextFreeDate = ends.find(e => busyAt(e) < slots) || null
  return { slots, used: usedNow, full: true, nextFreeDate }
}

// Catalogue public (formules actives) avec la disponibilité du carrousel pour ce membre
async function publicCatalog(user) {
  await ensureDefaultOffers()
  const offers = await prisma.extraOffer.findMany({ where: { active: true }, orderBy: [{ position: 'asc' }, { id: 'asc' }] })
  let carousel = null
  if (offers.some(o => o.kind === 'CAROUSEL') && user) {
    const profile = await prisma.profile.findUnique({ where: { userId: user.id }, select: { id: true } })
    const regionCode = profile ? await ensureProfileRegion(profile.id) : null
    const [regional, national] = await Promise.all([
      regionCode ? carouselAvailability('REGIONAL', regionCode) : null,
      carouselAvailability('NATIONAL', null),
    ])
    carousel = { regionCode, regionName: regionName(regionCode), regional, national }
  }
  return {
    offers: offers.map(o => ({ id: o.id, kind: o.kind, title: o.title, description: o.description, options: o.options })),
    carousel,
  }
}

async function createExtraCheckout({ user, offerId, optionId, startDate }) {
  const stripe = getStripe()
  if (!stripe) throw new BillingError('PAYMENTS_UNAVAILABLE', 'Les paiements en ligne ne sont pas encore ouverts.', 503)
  const offer = await prisma.extraOffer.findUnique({ where: { id: Number(offerId) } })
  if (!offer || !offer.active) throw new BillingError('OFFER_NOT_FOUND', 'Cette formule n’est plus proposée.', 404)
  const option = (Array.isArray(offer.options) ? offer.options : []).find(o => o.id === optionId)
  if (!option) throw new BillingError('OPTION_NOT_FOUND', 'Option introuvable.', 404)
  const profile = await prisma.profile.findUnique({ where: { userId: user.id }, select: { id: true } })
  if (!profile) throw new BillingError('PROFILE_NOT_FOUND', 'Profil introuvable.', 404)

  const scope = option.scope || null
  let regionCode = null
  if (scope === 'REGIONAL') {
    regionCode = await ensureProfileRegion(profile.id)
    if (!regionCode) throw new BillingError('REGION_UNKNOWN', 'Renseignez votre ville (en France) dans votre profil pour choisir une formule régionale.')
  }

  // Carrousel : une place doit être libre à la date choisie, sinon on propose la première date libre
  let desiredStart = null
  if (offer.kind === 'CAROUSEL') {
    const wanted = startDate ? new Date(startDate) : new Date()
    if (Number.isNaN(wanted.getTime())) throw new BillingError('DATE_INVALID', 'Date invalide.')
    const from = wanted < new Date() ? new Date() : wanted
    const availability = await carouselAvailability(scope, regionCode, from)
    if (availability.full) {
      const err = new BillingError('CAROUSEL_FULL', availability.nextFreeDate
        ? `Complet jusqu'au ${availability.nextFreeDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}. Vous pouvez réserver un affichage à partir de cette date.`
        : 'Complet pour le moment.', 409)
      err.nextFreeDate = availability.nextFreeDate
      throw err
    }
    desiredStart = from
  }

  const order = await prisma.extraOrder.create({
    data: {
      offerId: offer.id, userId: user.id, profileId: profile.id, kind: offer.kind,
      label: `${offer.title} — ${option.label}`, days: option.days ?? null, scope, regionCode,
      amountCents: option.priceCents, desiredStart,
    },
  })

  const customer = await getOrCreateCustomer(stripe, user.id)
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer,
    client_reference_id: String(user.id),
    locale: 'fr',
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: option.priceCents, product_data: { name: order.label } } }],
    invoice_creation: { enabled: true }, // facture LS Bookers envoyée par Stripe
    payment_intent_data: { metadata: { kind: 'extra', orderId: String(order.id) } },
    metadata: { kind: 'extra', orderId: String(order.id), userId: String(user.id) },
    success_url: `${siteUrl()}/subscriptions?formule=ok`,
    cancel_url: `${siteUrl()}/subscriptions?formule=annule`,
  })
  await prisma.extraOrder.update({ where: { id: order.id }, data: { stripeSessionId: session.id } })
  return { url: session.url }
}

// Paiement confirmé par Stripe : la commande attend la validation de l'admin
async function markOrderPaid(session) {
  const orderId = Number(session.metadata?.orderId)
  if (!orderId) return
  const order = await prisma.extraOrder.findUnique({ where: { id: orderId }, include: { user: { select: { pseudo: true, firstName: true, lastName: true } } } })
  if (!order || order.status !== 'PENDING_PAYMENT') return
  await prisma.extraOrder.update({
    where: { id: order.id },
    data: { status: 'PAID', paidAt: new Date(), stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null },
  })
  const who = order.user?.pseudo || [order.user?.firstName, order.user?.lastName].filter(Boolean).join(' ') || 'Un membre'
  const zone = order.scope === 'REGIONAL' ? ` (${regionName(order.regionCode) || 'régional'})` : order.scope === 'NATIONAL' ? ' (national)' : ''
  await notifyAdmins({
    type: order.kind === 'CAROUSEL' ? 'ADMIN_CAROUSEL_REQUEST' : 'ADMIN_EXTRA_ORDER',
    content: `${who} a acheté « ${order.label} »${zone}. À valider dans l'admin.`,
    actorId: order.userId,
  })
}

/**
 * Validation par l'admin. Carrousel : création de la mise en avant avec la durée choisie
 * (ajustable). Autres formules : marquées « réalisée » une fois faites à la main.
 */
async function validateOrder(orderId, { startsAt, endsAt, note } = {}) {
  const order = await prisma.extraOrder.findUnique({ where: { id: orderId } })
  if (!order) throw new BillingError('ORDER_NOT_FOUND', 'Commande introuvable.', 404)
  if (order.status !== 'PAID') throw new BillingError('ORDER_NOT_PAYABLE', 'Cette commande a déjà été traitée.')

  if (order.kind === 'CAROUSEL') {
    const start = startsAt ? new Date(startsAt) : (order.desiredStart && order.desiredStart > new Date() ? order.desiredStart : new Date())
    const end = endsAt ? new Date(endsAt) : new Date(start.getTime() + (order.days || 7) * DAY)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new BillingError('DATE_INVALID', 'Dates invalides.')
    const last = await prisma.homeFeatured.findFirst({ orderBy: { position: 'desc' }, select: { position: true } })
    await prisma.$transaction([
      prisma.homeFeatured.create({
        data: {
          profileId: order.profileId, scope: order.scope || 'NATIONAL', regionCode: order.regionCode,
          startsAt: start, endsAt: end, orderId: order.id, position: (last?.position ?? -1) + 1,
          note: `Commande n° ${order.id}${note ? ` — ${note}` : ''}`,
        },
      }),
      prisma.extraOrder.update({ where: { id: order.id }, data: { status: 'ACTIVE', handledAt: new Date(), adminNote: note || null } }),
    ])
    const fmt = (d) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
    await createNotif({ userId: order.userId, type: 'EXTRA_ORDER_UPDATE', content: `Votre mise en avant dans le carrousel est validée : du ${fmt(start)} au ${fmt(end)}.` })
  } else {
    await prisma.extraOrder.update({ where: { id: order.id }, data: { status: 'DONE', handledAt: new Date(), adminNote: note || null } })
    await createNotif({ userId: order.userId, type: 'EXTRA_ORDER_UPDATE', content: `Votre formule « ${order.label} » a été réalisée. Merci !` })
  }
  return prisma.extraOrder.findUnique({ where: { id: order.id } })
}

// Refus par l'admin : remboursement complet
async function refuseOrder(orderId, { note } = {}) {
  const order = await prisma.extraOrder.findUnique({ where: { id: orderId } })
  if (!order) throw new BillingError('ORDER_NOT_FOUND', 'Commande introuvable.', 404)
  if (order.status !== 'PAID') throw new BillingError('ORDER_NOT_PAYABLE', 'Cette commande a déjà été traitée.')
  const stripe = getStripe()
  if (order.stripePaymentIntentId) {
    if (!stripe) throw new BillingError('PAYMENTS_UNAVAILABLE', 'Stripe n’est pas configuré : remboursement impossible.', 503)
    await stripe.refunds.create({ payment_intent: order.stripePaymentIntentId, metadata: { kind: 'extra', orderId: String(order.id) } })
  }
  const updated = await prisma.extraOrder.update({
    where: { id: order.id },
    data: { status: 'REFUSED', handledAt: new Date(), refundedCents: order.amountCents, adminNote: note || null },
  })
  await createNotif({ userId: order.userId, type: 'EXTRA_ORDER_UPDATE', content: `Votre formule « ${order.label} » n'a pas pu être réalisée : vous êtes intégralement remboursé.${note ? ` (${note})` : ''}` })
  return updated
}

/**
 * Profils du carrousel pour un membre : mises en avant offertes par l'admin (partout, hors quota),
 * puis nationales payées, puis celles de sa région.
 */
async function carouselFeatured(viewerRegionCode) {
  const settings = await getPlanSettings()
  const now = new Date()
  const live = { AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] }
  const member = { profile: { user: { role: { in: ['ARTIST', 'ORGANIZER', 'PROVIDER'] }, pausedAt: null, bannedAt: null } } }
  const include = { profile: { include: { user: true } } }
  const order = [{ position: 'asc' }, { createdAt: 'asc' }]
  const [admin, national, regional] = await Promise.all([
    prisma.homeFeatured.findMany({ where: { scope: 'ADMIN', ...live, ...member }, orderBy: order, include }),
    prisma.homeFeatured.findMany({ where: { scope: 'NATIONAL', ...live, ...member }, orderBy: order, include, take: settings.carousel.nationalSlots }),
    viewerRegionCode
      ? prisma.homeFeatured.findMany({ where: { scope: 'REGIONAL', regionCode: viewerRegionCode, ...live, ...member }, orderBy: order, include, take: settings.carousel.regionalSlots })
      : [],
  ])
  const seen = new Set()
  return [...admin, ...national, ...regional].filter(f => (seen.has(f.profileId) ? false : seen.add(f.profileId)))
}

module.exports = {
  KINDS, SCOPES, DEFAULT_OFFERS, ensureDefaultOffers, sanitizeOptions, carouselAvailability, publicCatalog,
  createExtraCheckout, markOrderPaid, validateOrder, refuseOrder, carouselFeatured,
}
