const test = require('node:test')
const assert = require('node:assert/strict')

const prisma = require('../prisma/client')
const { computeSplit, cancellationOutcome, prestationEnd, payeeEligibility } = require('../services/bookingPayments')
const { isProSubscription, checkLimit, boostPro, startOfMonthParis } = require('../lib/plan')
const { deepMerge, DEFAULT_PLAN_SETTINGS, clearPlanSettingsCache } = require('../lib/planSettings')
const { sanitizeSettings } = require('../routes/adminBilling')
const { sanitizeOptions, carouselAvailability } = require('../services/extras')
const billing = require('../services/billing')

async function withMocks(mocks, fn) {
  const originals = []
  for (const [model, methods] of Object.entries(mocks)) {
    for (const [name, impl] of Object.entries(methods)) {
      originals.push([model, name, prisma[model][name]])
      prisma[model][name] = impl
    }
  }
  try { return await fn() } finally {
    for (const [model, name, original] of originals) prisma[model][name] = original
  }
}

const noSettings = { adminSettings: { findUnique: async () => null } }

test('répartition : 500 € en compte gratuit (10 %) → 450 € pour l’artiste, 150 € de part acquise', () => {
  const s = computeSplit(50000, 10, 30)
  assert.equal(s.commissionCents, 5000)
  assert.equal(s.payeeNetCents, 45000)
  assert.equal(s.depositCents, 15000)
  assert.equal(computeSplit(50000, 5, 30).payeeNetCents, 47500)
})

test('annulation par l’organisateur à moins de 7 jours : il perd les 30 % et la commission', () => {
  const o = cancellationOutcome({ amountCents: 50000, commissionCents: 5000, depositCents: 15000, stripeFeeCents: 800 }, { byPayer: true, late: true })
  assert.equal(o.refundCents, 30000)
  assert.equal(o.transferCents, 15000)
})

test('annulation à plus de 7 jours ou par l’artiste : remboursement moins les frais bancaires', () => {
  const amounts = { amountCents: 50000, commissionCents: 5000, depositCents: 15000, stripeFeeCents: 800 }
  assert.deepEqual(cancellationOutcome(amounts, { byPayer: true, late: false }), { refundCents: 49200, transferCents: 0, late: false })
  assert.deepEqual(cancellationOutcome(amounts, { byPayer: false, late: true }), { refundCents: 49200, transferCents: 0, late: true })
})

test('fin de prestation : fin de journée si le booking n’a qu’une date', () => {
  assert.equal(prestationEnd({ startDate: '2027-03-10T00:00:00.000Z' }).toISOString(), '2027-03-11T00:00:00.000Z')
  assert.equal(prestationEnd({ startDate: '2027-03-10T21:00:00.000Z', endDate: '2027-03-11T02:00:00.000Z' }).toISOString(), '2027-03-11T02:00:00.000Z')
})

test('paiement en ligne refusé pour un intermittent ou un compte de paiement non activé', () => {
  assert.equal(payeeEligibility({ legalStatus: 'INTERMITTENT', user: { stripeAccountId: 'acct_1', isPaymentEnabled: true } }).code, 'PAYEE_INTERMITTENT')
  assert.equal(payeeEligibility({ legalStatus: null, user: { payoutMode: 'INTERMITTENT', stripeAccountId: 'acct_1', isPaymentEnabled: true } }).code, 'PAYEE_INTERMITTENT')
  assert.equal(payeeEligibility({ legalStatus: 'COMPANY', user: { stripeAccountId: null, isPaymentEnabled: false } }).code, 'PAYEE_NOT_READY')
  assert.equal(payeeEligibility({ legalStatus: 'COMPANY', user: { stripeAccountId: 'acct_1', isPaymentEnabled: true } }).ok, true)
})

test('Pro : essai, payé, relance et résilié jusqu’à la fin de la période', () => {
  const future = new Date(Date.now() + 86400000)
  const past = new Date(Date.now() - 86400000)
  assert.equal(isProSubscription(null), false)
  assert.equal(isProSubscription({ status: 'TRIAL' }), true)
  assert.equal(isProSubscription({ status: 'PAST_DUE' }), true)
  assert.equal(isProSubscription({ status: 'CANCELLED', currentPeriodEnd: future }), true)
  assert.equal(isProSubscription({ status: 'CANCELLED', currentPeriodEnd: past }), false)
  assert.equal(isProSubscription({ status: 'ACTIVE', endDate: past }), false)
  assert.equal(isProSubscription({ status: 'EXPIRED' }), false)
})

test('limite du compte gratuit : 3 candidatures par mois, la 4e est refusée', async () => {
  clearPlanSettingsCache()
  await withMocks({
    ...noSettings,
    subscription: { findUnique: async () => null },
    application: { count: async () => 3 },
  }, async () => {
    const res = await checkLimit({ id: 7, role: 'ARTIST' }, 'applicationsPerMonth', { profileId: 4 })
    assert.equal(res.error, 'PRO_LIMIT')
    assert.equal(res.max, 3)
    assert.match(res.message, /3 candidatures par mois/)
  })
  clearPlanSettingsCache()
})

test('limite du compte gratuit : pas de limite en Pro, ni pour l’admin', async () => {
  clearPlanSettingsCache()
  await withMocks({
    ...noSettings,
    subscription: { findUnique: async () => ({ status: 'ACTIVE' }) },
    application: { count: async () => 99 },
  }, async () => {
    assert.equal(await checkLimit({ id: 7, role: 'ARTIST' }, 'applicationsPerMonth', { profileId: 4 }), null)
    assert.equal(await checkLimit({ id: 1, role: 'ADMIN' }, 'applicationsPerMonth', { profileId: 4 }), null)
  })
  clearPlanSettingsCache()
})

test('limite vidéos : 4 vidéos déjà publiées + 2 nouvelles dépassent les 5 autorisées', async () => {
  clearPlanSettingsCache()
  await withMocks({
    ...noSettings,
    subscription: { findUnique: async () => null },
    publication: { count: async () => 3 },
    publicationMedia: { count: async () => 1 },
  }, async () => {
    const res = await checkLimit({ id: 7, role: 'ARTIST' }, 'videos', { profileId: 4, adding: 2 })
    assert.equal(res?.limit, 'videos')
    assert.equal(await checkLimit({ id: 7, role: 'ARTIST' }, 'videos', { profileId: 4, adding: 1 }), null)
  })
  clearPlanSettingsCache()
})

test('début de mois à l’heure de Paris', () => {
  const start = startOfMonthParis(new Date('2026-11-15T10:00:00Z'))
  assert.ok(start <= new Date('2026-10-31T23:00:00Z'))
  assert.ok(start >= new Date('2026-10-31T21:00:00Z'))
})

test('coup de pouce Pro : remonte de quelques places sans passer devant tout le monde', () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ id: i, pro: i === 8 }))
  const ranked = boostPro(list, x => x.pro).map(x => x.id)
  assert.equal(ranked.indexOf(8), 5)
  assert.equal(ranked[0], 0)
})

test('réglages admin : valeurs inconnues ignorées, commission plafonnée, décimale gardée', () => {
  assert.deepEqual(sanitizeSettings({ commission: { freePct: '7.5' }, pirate: 1 }), { commission: { freePct: 7.5 } })
  assert.throws(() => sanitizeSettings({ commission: { proPct: 80 } }), /50 %/)
  assert.throws(() => sanitizeSettings({ limits: { albums: -1 } }))
  const merged = deepMerge(DEFAULT_PLAN_SETTINGS, { limits: { albums: 5 } })
  assert.equal(merged.limits.albums, 5)
  assert.equal(merged.limits.videos, 5)
})

test('options du carrousel : régional ou national et durée obligatoires', () => {
  assert.throws(() => sanitizeOptions('CAROUSEL', [{ label: 'Test', priceCents: 1000 }]), /régional ou national/)
  const [opt] = sanitizeOptions('CAROUSEL', [{ label: 'Régional 7 j', priceCents: 1500, scope: 'REGIONAL', days: 7 }])
  assert.equal(opt.scope, 'REGIONAL')
  assert.equal(opt.days, 7)
  assert.throws(() => sanitizeOptions('SOCIAL', [{ label: 'Post', priceCents: 50 }]), /1 €/)
})

test('carrousel : région complète (12 places) → première date libre annoncée', async () => {
  clearPlanSettingsCache()
  const now = new Date()
  const ends = Array.from({ length: 12 }, (_, i) => new Date(now.getTime() + (i + 2) * 86400000))
  await withMocks({
    ...noSettings,
    homeFeatured: { findMany: async () => ends.map(e => ({ startsAt: null, endsAt: e })) },
    extraOrder: { findMany: async () => [] },
  }, async () => {
    const a = await carouselAvailability('REGIONAL', '93', now)
    assert.equal(a.full, true)
    assert.equal(a.nextFreeDate.getTime(), ends[0].getTime())
  })
  await withMocks({
    ...noSettings,
    homeFeatured: { findMany: async () => ends.slice(0, 5).map(e => ({ startsAt: null, endsAt: e })) },
    extraOrder: { findMany: async () => [] },
  }, async () => {
    const a = await carouselAvailability('REGIONAL', '93', now)
    assert.equal(a.full, false)
    assert.equal(a.used, 5)
  })
  clearPlanSettingsCache()
})

test('code promo : un code Fondateur ne s’utilise pas comme code de lancement', async () => {
  await withMocks({
    promoCode: { findUnique: async () => ({ id: 1, code: 'FONDATEUR-AB12', kind: 'FOUNDER', active: true, maxUses: 1, usedCount: 0 }) },
    promoRedemption: { findUnique: async () => null },
  }, async () => {
    await assert.rejects(() => billing.checkPromoCode('fondateur-ab12', 3, 'LAUNCH'), err => err.code === 'PROMO_WRONG_KIND')
    const ok = await billing.checkPromoCode(' fondateur-ab12 ', 3, 'FOUNDER')
    assert.equal(ok.id, 1)
  })
})

test('code promo déjà utilisé (usage unique) refusé', async () => {
  await withMocks({
    promoCode: { findUnique: async () => ({ id: 1, code: 'FONDATEUR-AB12', kind: 'FOUNDER', active: true, maxUses: 1, usedCount: 1 }) },
    promoRedemption: { findUnique: async () => null },
  }, async () => {
    await assert.rejects(() => billing.checkPromoCode('FONDATEUR-AB12', 3, 'FOUNDER'), err => err.code === 'PROMO_USED')
  })
})

test('abonnement Stripe recopié : essai, formule annuelle, fin de période', async () => {
  let saved
  await withMocks({
    subscription: { findUnique: async () => null, upsert: async ({ create }) => { saved = create; return create } },
  }, async () => {
    await billing.syncStripeSubscription({
      id: 'sub_1', status: 'trialing', metadata: { userId: '9' }, trial_end: 1800000000, cancel_at_period_end: false, start_date: 1790000000,
      items: { data: [{ current_period_end: 1800000000, price: { unit_amount: 11999, recurring: { interval: 'year' } } }] },
    })
  })
  assert.equal(saved.userId, 9)
  assert.equal(saved.status, 'TRIAL')
  assert.equal(saved.interval, 'YEAR')
  assert.equal(saved.priceCents, 11999)
  assert.equal(saved.currentPeriodEnd.getTime(), 1800000000 * 1000)
})

test('abonnement Stripe : un Pro offert (Fondateur) n’est jamais écrasé', async () => {
  let wrote = false
  await withMocks({
    subscription: { findUnique: async () => ({ source: 'FOUNDER', status: 'ACTIVE' }), upsert: async () => { wrote = true } },
  }, async () => {
    await billing.syncStripeSubscription({ id: 'sub_old', status: 'canceled', metadata: { userId: '9' }, items: { data: [] } })
  })
  assert.equal(wrote, false)
})
