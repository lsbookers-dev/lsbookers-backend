// services/agency.js — Formule Agence : places de profils, profils en plus, et Pro des artistes gérés.
// Règles validées avec Antho (27/10/2026) :
// - 5 profils gérés inclus (réglable), chaque profil en plus est facturé (prorata) et
//   retiré de la facture dès qu'une place se libère ; une invitation en attente occupe une place ;
// - un profil géré est Pro tant que son agence a la formule. S'il payait déjà son propre Pro,
//   ses prélèvements sont suspendus pendant la collaboration, puis reprennent tout seuls ;
// - agence sans formule depuis 30 jours : les gestions s'arrêtent et les artistes sont prévenus.
const prisma = require('../prisma/client')
const { getStripe } = require('../lib/stripe')
const { getPlanSettings } = require('../lib/planSettings')
const { hasAgency, isProSubscription } = require('../lib/plan')
const { createNotif } = require('./notifications')

const GRACE_DAYS = 30

class AgencyError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra) }
}

/** Places de profils de l'agence : utilisées, incluses, payées en plus */
async function profileSlots(managerUserId) {
  const [settings, agency, account, used] = await Promise.all([
    getPlanSettings(),
    prisma.agencySubscription.findUnique({ where: { userId: managerUserId } }),
    prisma.user.findUnique({ where: { id: managerUserId }, select: { canManageProfiles: true } }),
    prisma.profileManager.count({
      where: {
        managerUserId,
        OR: [{ status: 'ACTIVE' }, { status: 'PENDING', expiresAt: { gt: new Date() } }],
      },
    }),
  ])
  const paid = isProSubscription(agency) && !!agency?.stripeSubId
  const included = Number(settings.agency?.includedProfiles) || 0
  const extra = paid ? agency.extraProfiles || 0 : 0
  // Formule offerte par l'admin (sans abonnement payé) : pas de limite
  const unlimited = !!account?.canManageProfiles && !paid
  const interval = agency?.interval === 'YEAR' ? 'YEAR' : 'MONTH'
  const extraPriceCents = interval === 'YEAR' ? settings.agency?.extraYearCents : settings.agency?.extraMonthCents
  return { used, included, extra, unlimited, paid, interval, extraPriceCents, agency }
}

/** Nombre de profils en plus facturés sur l'abonnement Stripe (prorata dans les deux sens) */
async function setExtraProfiles(agency, quantity) {
  const stripe = getStripe()
  if (!stripe || !agency?.stripeSubId) throw new AgencyError('PAYMENTS_UNAVAILABLE', 'Les paiements en ligne ne sont pas encore ouverts.', 503)
  const qty = Math.max(0, Math.round(quantity))
  if (qty === (agency.extraProfiles || 0)) return agency
  const settings = await getPlanSettings()
  let itemId = agency.stripeExtraItemId
  if (qty === 0 && itemId) {
    await stripe.subscriptionItems.del(itemId, { proration_behavior: 'create_prorations' })
    itemId = null
  } else if (itemId) {
    await stripe.subscriptionItems.update(itemId, { quantity: qty, proration_behavior: 'create_prorations' })
  } else if (qty > 0) {
    const year = agency.interval === 'YEAR'
    const price = await stripe.prices.create({
      currency: 'eur',
      unit_amount: year ? settings.agency.extraYearCents : settings.agency.extraMonthCents,
      recurring: { interval: year ? 'year' : 'month' },
      product_data: { name: 'LS Bookers Agence — profil en plus' },
    })
    const item = await stripe.subscriptionItems.create({ subscription: agency.stripeSubId, price: price.id, quantity: qty, proration_behavior: 'create_prorations' })
    itemId = item.id
  }
  return prisma.agencySubscription.update({ where: { id: agency.id }, data: { extraProfiles: qty, stripeExtraItemId: itemId } })
}

/**
 * Avant d'ajouter un profil (invitation ou création) : une place est-elle libre ?
 * Sinon, avec l'accord de l'agent (acceptExtra), on ajoute un profil en plus à la facture.
 */
async function reserveSlot(managerUserId, { acceptExtra = false } = {}) {
  const slots = await profileSlots(managerUserId)
  if (slots.unlimited || slots.used < slots.included + slots.extra) return slots
  if (!slots.paid) {
    throw new AgencyError('AGENCY_LIMIT', `Votre formule comprend ${slots.included} profils. Passez à la formule Agence payante pour en ajouter.`, 403)
  }
  if (!acceptExtra) {
    throw new AgencyError('EXTRA_PROFILE_REQUIRED', 'Toutes les places de votre formule sont prises.', 402, {
      extraPriceCents: slots.extraPriceCents, interval: slots.interval, included: slots.included, used: slots.used,
    })
  }
  await setExtraProfiles(slots.agency, slots.used + 1 - slots.included)
  return profileSlots(managerUserId)
}

/** Une place s'est libérée : on retire les profils en plus devenus inutiles */
async function releaseSlots(managerUserId) {
  try {
    const slots = await profileSlots(managerUserId)
    if (!slots.paid || !slots.extra) return
    const needed = Math.max(0, slots.used - slots.included)
    if (needed < slots.extra) await setExtraProfiles(slots.agency, needed)
  } catch (err) {
    console.error('Agence : mise à jour des profils en plus', err.message)
  }
}

// ── Pro propre de l'artiste : suspendu pendant la gestion ────

async function pauseOwnPro(userId, agencyName) {
  const sub = await prisma.subscription.findUnique({ where: { userId } })
  if (!sub?.stripeSubId || sub.source !== 'STRIPE' || sub.pausedByAgency || !isProSubscription(sub) || sub.status === 'CANCELLED') return
  const stripe = getStripe()
  if (!stripe) return
  await stripe.subscriptions.update(sub.stripeSubId, { pause_collection: { behavior: 'void' } })
  await prisma.subscription.update({ where: { id: sub.id }, data: { pausedByAgency: true } })
  await createNotif({
    userId,
    type: 'SUBSCRIPTION_UPDATE',
    content: `Votre profil est Pro grâce à ${agencyName} : les prélèvements de votre abonnement Pro sont suspendus tant que vous travaillez ensemble. Ils reprendront automatiquement à la fin de la collaboration.`,
  })
}

async function resumeOwnPro(userId) {
  const sub = await prisma.subscription.findUnique({ where: { userId } })
  if (!sub?.pausedByAgency) return
  const stripe = getStripe()
  if (stripe && sub.stripeSubId) await stripe.subscriptions.update(sub.stripeSubId, { pause_collection: '' })
  await prisma.subscription.update({ where: { id: sub.id }, data: { pausedByAgency: false } })
  await createNotif({
    userId,
    type: 'SUBSCRIPTION_UPDATE',
    content: 'Votre profil n’est plus géré par une agence : votre abonnement Pro reprend normalement.',
  })
}

const agencyName = (u) => u?.pseudo || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || 'votre agence'

/** Gestion acceptée : si l'agence a la formule, le Pro propre de l'artiste est suspendu */
async function onManagementActive(managementId) {
  try {
    const m = await prisma.profileManager.findUnique({
      where: { id: managementId },
      select: { status: true, managerUserId: true, manager: { select: { pseudo: true, firstName: true, lastName: true } }, profile: { select: { userId: true } } },
    })
    if (m?.status !== 'ACTIVE' || !(await hasAgency(m.managerUserId))) return
    await pauseOwnPro(m.profile.userId, agencyName(m.manager))
  } catch (err) {
    console.error('Agence : suspension du Pro de l’artiste', err.message)
  }
}

/** Gestion terminée : le Pro propre reprend, et la place se libère */
async function onManagementEnded(managementId) {
  try {
    const m = await prisma.profileManager.findUnique({ where: { id: managementId }, select: { managerUserId: true, profile: { select: { userId: true } } } })
    if (!m) return
    await resumeOwnPro(m.profile.userId)
    await releaseSlots(m.managerUserId)
  } catch (err) {
    console.error('Agence : fin de gestion', err.message)
  }
}

/** La formule de l'agence change (achat, arrêt) : on suspend ou on relance le Pro de ses artistes */
async function onAgencyChanged(managerUserId) {
  try {
    const [active, manager, managed] = await Promise.all([
      hasAgency(managerUserId),
      prisma.user.findUnique({ where: { id: managerUserId }, select: { pseudo: true, firstName: true, lastName: true } }),
      prisma.profileManager.findMany({ where: { managerUserId, status: 'ACTIVE' }, select: { profile: { select: { userId: true } } } }),
    ])
    for (const m of managed) {
      if (active) await pauseOwnPro(m.profile.userId, agencyName(manager))
      else await resumeOwnPro(m.profile.userId)
    }
  } catch (err) {
    console.error('Agence : changement de formule', err.message)
  }
}

/** Tâche quotidienne : formule arrêtée depuis plus de 30 jours → fin des gestions */
async function endLapsedManagements(now = new Date()) {
  const limit = new Date(now.getTime() - GRACE_DAYS * 24 * 60 * 60 * 1000)
  const lapsed = await prisma.agencySubscription.findMany({
    where: { endDate: { lte: limit }, user: { canManageProfiles: false, managedProfiles: { some: { status: { in: ['ACTIVE', 'PENDING'] } } } } },
    select: { userId: true, user: { select: { pseudo: true, firstName: true, lastName: true } } },
  })
  for (const a of lapsed) {
    if (await hasAgency(a.userId)) continue // formule reprise entre-temps
    const list = await prisma.profileManager.findMany({
      where: { managerUserId: a.userId, status: { in: ['ACTIVE', 'PENDING'] } },
      select: { id: true, status: true, profile: { select: { userId: true } } },
    })
    await prisma.profileManager.updateMany({ where: { id: { in: list.map(m => m.id) } }, data: { status: 'ENDED', endedAt: now, endedBy: 'EXPIRED', tokenHash: null } })
    for (const m of list.filter(x => x.status === 'ACTIVE')) {
      await resumeOwnPro(m.profile.userId).catch(() => {})
      await createNotif({
        userId: m.profile.userId,
        type: 'MANAGEMENT_ENDED',
        content: `${agencyName(a.user)} n’a plus la formule Agence : votre profil n’est plus géré. Vous gardez tout : profil, avis, agenda et conversations.`,
      })
    }
  }
}

module.exports = {
  AgencyError, GRACE_DAYS, profileSlots, reserveSlot, releaseSlots, setExtraProfiles,
  pauseOwnPro, resumeOwnPro, onManagementActive, onManagementEnded, onAgencyChanged, endLapsedManagements,
}
