// routes/adminBilling.js — Admin › Offres et abonnements : réglages (commissions, limites, prix,
// carrousel), codes promo, formules supplémentaires, commandes à valider, annulations tardives.
const express = require('express')
const crypto = require('crypto')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const { DEFAULT_PLAN_SETTINGS, getPlanSettings, clearPlanSettingsCache, deepMerge } = require('../lib/planSettings')
const { isProSubscription } = require('../lib/plan')
const { regionName } = require('../lib/regions')
const { getStripe } = require('../lib/stripe')
const extras = require('../services/extras')
const { BillingError, normalizeCode } = require('../services/billing')
const { createNotif } = require('../services/notifications')
const { sendError } = require('./billing')

router.use(requireAuth, requireAdmin)

const userName = (u) => u?.pseudo || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.email || 'Utilisateur'
const USER_SELECT = { id: true, email: true, pseudo: true, firstName: true, lastName: true, role: true }

/* ── Réglages ─────────────────────────────────────────── */

// Garde uniquement des nombres valides, aux bons endroits
function sanitizeSettings(input, base = DEFAULT_PLAN_SETTINGS, path = '') {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const [key, def] of Object.entries(base)) {
    if (!(key in input)) continue
    const value = input[key]
    if (def && typeof def === 'object') {
      const nested = sanitizeSettings(value, def, `${path}${key}.`)
      if (Object.keys(nested).length) out[key] = nested
    } else {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) throw new BillingError('SETTINGS_INVALID', `Valeur invalide pour ${path}${key}.`)
      if (path.startsWith('commission.') && n > 50) throw new BillingError('SETTINGS_INVALID', 'Une commission ne peut pas dépasser 50 %.')
      // Les commissions peuvent avoir une décimale (ex. 7,5 %) ; le reste est entier
      out[key] = path.startsWith('commission.') ? Math.round(n * 10) / 10 : Math.round(n)
    }
  }
  return out
}

router.get('/settings', async (_req, res) => {
  try {
    res.json({ settings: await getPlanSettings(), defaults: DEFAULT_PLAN_SETTINGS, stripeConfigured: !!getStripe(), webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET, connectWebhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET_CONNECT, testMode: String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_') })
  } catch (err) { sendError(res, err, 'GET admin/billing/settings') }
})

router.put('/settings', async (req, res) => {
  try {
    const clean = sanitizeSettings(req.body?.settings)
    const row = await prisma.adminSettings.findUnique({ where: { id: 1 }, select: { planSettings: true } })
    const merged = deepMerge(deepMerge(DEFAULT_PLAN_SETTINGS, row?.planSettings || {}), clean)
    await prisma.adminSettings.upsert({ where: { id: 1 }, create: { id: 1, planSettings: merged }, update: { planSettings: merged } })
    clearPlanSettingsCache()
    res.json({ settings: await getPlanSettings() })
  } catch (err) { sendError(res, err, 'PUT admin/billing/settings') }
})

/* ── Codes promo ──────────────────────────────────────── */

const randomCode = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`

router.get('/promo-codes', async (_req, res) => {
  try {
    const codes = await prisma.promoCode.findMany({
      orderBy: { createdAt: 'desc' },
      include: { redemptions: { include: { user: { select: USER_SELECT } }, orderBy: { createdAt: 'desc' } } },
    })
    res.json({
      codes: codes.map(c => ({
        id: c.id, code: c.code, kind: c.kind, freeMonths: c.freeMonths, maxUses: c.maxUses, usedCount: c.usedCount,
        active: c.active, expiresAt: c.expiresAt, note: c.note, createdAt: c.createdAt,
        usedBy: c.redemptions.map(r => ({ id: r.user.id, name: userName(r.user), at: r.createdAt })),
      })),
    })
  } catch (err) { sendError(res, err, 'GET admin/billing/promo-codes') }
})

/**
 * POST /promo-codes
 * - Fondateur : { kind: 'FOUNDER', notes: ['Prénom Nom', …] } → un code unique par personne, usage unique
 * - Lancement : { kind: 'LAUNCH', code?, freeMonths, maxUses?, expiresAt? } → un code partagé
 */
router.post('/promo-codes', async (req, res) => {
  try {
    const kind = String(req.body?.kind || '').toUpperCase()
    const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new BillingError('DATE_INVALID', 'Date invalide.')
    if (kind === 'FOUNDER') {
      const notes = (Array.isArray(req.body?.notes) ? req.body.notes : []).map(n => String(n || '').trim().slice(0, 120)).filter(Boolean)
      if (!notes.length || notes.length > 100) throw new BillingError('NOTES_INVALID', 'Indiquez une personne par ligne (100 au maximum).')
      const created = []
      for (const note of notes) {
        created.push(await prisma.promoCode.create({ data: { code: randomCode('FONDATEUR'), kind, maxUses: 1, note, expiresAt } }))
      }
      return res.status(201).json({ codes: created })
    }
    if (kind === 'LAUNCH') {
      const freeMonths = Math.round(Number(req.body?.freeMonths))
      if (!Number.isFinite(freeMonths) || freeMonths < 1 || freeMonths > 24) throw new BillingError('MONTHS_INVALID', 'Nombre de mois offerts invalide (1 à 24).')
      const code = normalizeCode(req.body?.code) || randomCode('LANCEMENT')
      if (!/^[A-Z0-9-]{4,30}$/.test(code)) throw new BillingError('CODE_INVALID', 'Le code doit contenir 4 à 30 lettres, chiffres ou tirets.')
      const maxUses = req.body?.maxUses ? Math.round(Number(req.body.maxUses)) : null
      const created = await prisma.promoCode.create({ data: { code, kind, freeMonths, maxUses: maxUses > 0 ? maxUses : null, expiresAt, note: String(req.body?.note || '').slice(0, 120) || null } })
      return res.status(201).json({ codes: [created] })
    }
    throw new BillingError('KIND_INVALID', 'Type de code inconnu.')
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'CODE_EXISTS', message: 'Ce code existe déjà.' })
    sendError(res, err, 'POST admin/billing/promo-codes')
  }
})

router.patch('/promo-codes/:id(\\d+)', async (req, res) => {
  try {
    const data = {}
    if (typeof req.body?.active === 'boolean') data.active = req.body.active
    if (req.body?.note !== undefined) data.note = String(req.body.note || '').slice(0, 120) || null
    const code = await prisma.promoCode.update({ where: { id: Number(req.params.id) }, data })
    res.json({ code })
  } catch (err) { sendError(res, err, 'PATCH admin/billing/promo-codes') }
})

/* ── Formules supplémentaires ─────────────────────────── */

router.get('/extras', async (_req, res) => {
  try {
    await extras.ensureDefaultOffers()
    const offers = await prisma.extraOffer.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] })
    res.json({ offers })
  } catch (err) { sendError(res, err, 'GET admin/billing/extras') }
})

function offerData(body, partial = false) {
  const data = {}
  if (!partial || body.kind !== undefined) {
    const kind = String(body.kind || '').toUpperCase()
    if (!extras.KINDS.includes(kind)) throw new BillingError('KIND_INVALID', 'Type de formule inconnu.')
    data.kind = kind
  }
  if (!partial || body.title !== undefined) {
    data.title = String(body.title || '').trim().slice(0, 120)
    if (!data.title) throw new BillingError('TITLE_REQUIRED', 'Titre requis.')
  }
  if (body.description !== undefined) data.description = String(body.description || '').trim().slice(0, 600) || null
  if (typeof body.active === 'boolean') data.active = body.active
  if (body.position !== undefined) data.position = Math.round(Number(body.position)) || 0
  return data
}

router.post('/extras', async (req, res) => {
  try {
    const data = offerData(req.body || {})
    data.options = extras.sanitizeOptions(data.kind, req.body?.options || [])
    res.status(201).json({ offer: await prisma.extraOffer.create({ data }) })
  } catch (err) { sendError(res, err, 'POST admin/billing/extras') }
})

router.put('/extras/:id(\\d+)', async (req, res) => {
  try {
    const existing = await prisma.extraOffer.findUnique({ where: { id: Number(req.params.id) } })
    if (!existing) return res.status(404).json({ error: 'Formule introuvable' })
    const data = offerData(req.body || {}, true)
    if (req.body?.options !== undefined) data.options = extras.sanitizeOptions(data.kind || existing.kind, req.body.options)
    res.json({ offer: await prisma.extraOffer.update({ where: { id: existing.id }, data }) })
  } catch (err) { sendError(res, err, 'PUT admin/billing/extras') }
})

/* ── Commandes (carrousel, newsletter, réseaux…) ──────── */

router.get('/orders', async (req, res) => {
  try {
    const status = String(req.query.status || '').toUpperCase()
    const where = status === 'PENDING' ? { status: 'PAID' } : status ? { status } : { status: { not: 'PENDING_PAYMENT' } }
    const orders = await prisma.extraOrder.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 200,
      include: { user: { select: USER_SELECT }, profile: { select: { avatar: true, location: true, city: true } }, featured: true },
    })
    const pending = await prisma.extraOrder.count({ where: { status: 'PAID' } })
    res.json({
      pending,
      orders: orders.map(o => ({
        id: o.id, kind: o.kind, label: o.label, status: o.status, amountCents: o.amountCents, days: o.days,
        scope: o.scope, regionCode: o.regionCode, regionName: regionName(o.regionCode), desiredStart: o.desiredStart,
        paidAt: o.paidAt, handledAt: o.handledAt, adminNote: o.adminNote, createdAt: o.createdAt, refundedCents: o.refundedCents,
        featured: o.featured ? { startsAt: o.featured.startsAt, endsAt: o.featured.endsAt } : null,
        user: { id: o.user.id, name: userName(o.user), email: o.user.email, role: o.user.role, avatar: o.profile?.avatar || null, location: o.profile?.location || o.profile?.city || null },
      })),
    })
  } catch (err) { sendError(res, err, 'GET admin/billing/orders') }
})

router.get('/orders/pending-count', async (_req, res) => {
  try {
    const [carousel, other] = await Promise.all([
      prisma.extraOrder.count({ where: { status: 'PAID', kind: 'CAROUSEL' } }),
      prisma.extraOrder.count({ where: { status: 'PAID', kind: { not: 'CAROUSEL' } } }),
    ])
    res.json({ carousel, other })
  } catch (err) { sendError(res, err, 'GET admin/billing/orders/pending-count') }
})

router.post('/orders/:id(\\d+)/validate', async (req, res) => {
  try {
    res.json({ order: await extras.validateOrder(Number(req.params.id), { startsAt: req.body?.startsAt, endsAt: req.body?.endsAt, note: req.body?.note }) })
  } catch (err) { sendError(res, err, 'POST admin/billing/orders/validate') }
})

router.post('/orders/:id(\\d+)/refuse', async (req, res) => {
  try {
    res.json({ order: await extras.refuseOrder(Number(req.params.id), { note: req.body?.note }) })
  } catch (err) { sendError(res, err, 'POST admin/billing/orders/refuse') }
})

/* ── Abonnements ──────────────────────────────────────── */

router.get('/subscriptions', async (_req, res) => {
  try {
    const subs = await prisma.subscription.findMany({ orderBy: { updatedAt: 'desc' }, include: { user: { select: USER_SELECT } }, take: 500 })
    const list = subs.map(s => ({
      id: s.id, status: s.status, interval: s.interval, source: s.source, priceCents: s.priceCents, promoCode: s.promoCode,
      trialEndsAt: s.trialEndsAt, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, startDate: s.startDate,
      isPro: isProSubscription(s), user: { id: s.user.id, name: userName(s.user), email: s.user.email, role: s.user.role },
    }))
    const paying = list.filter(s => s.isPro && s.source === 'STRIPE' && s.status === 'ACTIVE')
    const mrrCents = paying.reduce((sum, s) => sum + (s.interval === 'YEAR' ? Math.round(s.priceCents / 12) : s.priceCents), 0)
    res.json({
      subscriptions: list,
      totals: {
        pro: list.filter(s => s.isPro).length,
        trial: list.filter(s => s.isPro && s.status === 'TRIAL').length,
        paying: paying.length,
        gifted: list.filter(s => s.isPro && s.source !== 'STRIPE').length,
        mrrCents,
      },
    })
  } catch (err) { sendError(res, err, 'GET admin/billing/subscriptions') }
})

// Offrir / retirer le Pro à un membre (hors Stripe)
router.post('/users/:id(\\d+)/gift-pro', async (req, res) => {
  try {
    const userId = Number(req.params.id)
    const existing = await prisma.subscription.findUnique({ where: { userId } })
    if (existing?.source === 'STRIPE' && isProSubscription(existing) && existing.status !== 'CANCELLED') {
      throw new BillingError('HAS_STRIPE_SUB', 'Ce membre a un abonnement payant en cours : il doit d’abord le résilier.')
    }
    const until = req.body?.until ? new Date(req.body.until) : null
    const data = { status: 'ACTIVE', plan: 'PRO', interval: 'LIFETIME', source: 'ADMIN', priceCents: 0, stripeSubId: null, trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, endDate: until && !Number.isNaN(until.getTime()) ? until : null }
    await prisma.subscription.upsert({ where: { userId }, create: { userId, ...data }, update: data })
    await createNotif({ userId, type: 'SUBSCRIPTION_UPDATE', content: 'LS Bookers vous offre le compte Pro. Profitez-en !' })
    res.json({ ok: true })
  } catch (err) { sendError(res, err, 'POST admin/billing/gift-pro') }
})

router.delete('/users/:id(\\d+)/gift-pro', async (req, res) => {
  try {
    const userId = Number(req.params.id)
    const existing = await prisma.subscription.findUnique({ where: { userId } })
    if (!existing || existing.source === 'STRIPE') throw new BillingError('NOT_GIFTED', 'Ce membre n’a pas de Pro offert.')
    await prisma.subscription.update({ where: { userId }, data: { status: 'EXPIRED', endDate: new Date() } })
    res.json({ ok: true })
  } catch (err) { sendError(res, err, 'DELETE admin/billing/gift-pro') }
})

/* ── Annulations tardives et bannissement ─────────────── */

router.get('/late-cancellations', async (_req, res) => {
  try {
    const settings = await getPlanSettings()
    const since = new Date(Date.now() - settings.lateCancellations.windowDays * 24 * 60 * 60 * 1000)
    const groups = await prisma.bookingRequest.groupBy({
      by: ['targetId'],
      where: { lateCancellation: true, cancelledAt: { gte: since } },
      _count: { _all: true },
    })
    const relevant = groups.filter(g => g._count._all >= settings.lateCancellations.warnAt)
    const profiles = await prisma.profile.findMany({
      where: { id: { in: relevant.map(g => g.targetId) } },
      select: { id: true, avatar: true, user: { select: { ...USER_SELECT, bannedAt: true, banReason: true, lateCancelWarnedAt: true } } },
    })
    // Seules les annulations faites par la personne bookée elle-même comptent
    const counts = await Promise.all(profiles.map(p => prisma.bookingRequest.findMany({
      where: { targetId: p.id, cancelledById: p.id, lateCancellation: true, cancelledAt: { gte: since } },
      select: { id: true, startDate: true, cancelledAt: true }, orderBy: { cancelledAt: 'desc' },
    })))
    const list = profiles.map((p, i) => ({
      userId: p.user.id, name: userName(p.user), email: p.user.email, role: p.user.role, avatar: p.avatar,
      count: counts[i].length, cancellations: counts[i],
      warnedAt: p.user.lateCancelWarnedAt, bannedAt: p.user.bannedAt, banReason: p.user.banReason,
      needsDecision: counts[i].length >= settings.lateCancellations.alertAt && !p.user.bannedAt,
    })).filter(x => x.count >= settings.lateCancellations.warnAt || x.bannedAt)
    list.sort((a, b) => Number(b.needsDecision) - Number(a.needsDecision) || b.count - a.count)
    const banned = await prisma.user.findMany({ where: { bannedAt: { not: null } }, select: { ...USER_SELECT, bannedAt: true, banReason: true } })
    res.json({ alerts: list, banned: banned.map(u => ({ userId: u.id, name: userName(u), email: u.email, bannedAt: u.bannedAt, banReason: u.banReason })), rules: settings.lateCancellations })
  } catch (err) { sendError(res, err, 'GET admin/billing/late-cancellations') }
})

router.post('/users/:id(\\d+)/ban', async (req, res) => {
  try {
    const userId = Number(req.params.id)
    if (userId === req.user.id) throw new BillingError('SELF', 'Vous ne pouvez pas vous bannir vous-même.')
    const reason = String(req.body?.reason || '').trim().slice(0, 300) || 'Annulations répétées à moins de 7 jours'
    // Bannir ferme aussi toutes ses sessions (tokenVersion)
    await prisma.user.update({ where: { id: userId }, data: { bannedAt: new Date(), banReason: reason, tokenVersion: { increment: 1 } } })
    res.json({ ok: true })
  } catch (err) { sendError(res, err, 'POST admin/billing/ban') }
})

router.post('/users/:id(\\d+)/unban', async (req, res) => {
  try {
    await prisma.user.update({ where: { id: Number(req.params.id) }, data: { bannedAt: null, banReason: null } })
    res.json({ ok: true })
  } catch (err) { sendError(res, err, 'POST admin/billing/unban') }
})

module.exports = router
module.exports.sanitizeSettings = sanitizeSettings
