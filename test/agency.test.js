// Formule Agence : places de profils, profils en plus, Pro des artistes gérés (suspendu / repris),
// passage d'un abonnement Pro à l'Agence. Stripe est simulé : aucun appel réel.
process.env.LSB_DISABLE_EMAILS = '1'

const test = require('node:test')
const assert = require('node:assert/strict')

const stripeCalls = []
const fakeStripe = {
  subscriptions: {
    update: async (id, data) => { stripeCalls.push(['subscriptions.update', id, data]); return {} },
    cancel: async (id, data) => { stripeCalls.push(['subscriptions.cancel', id, data]); return {} },
  },
  subscriptionItems: {
    create: async (data) => { stripeCalls.push(['items.create', data]); return { id: 'si_extra' } },
    update: async (id, data) => { stripeCalls.push(['items.update', id, data]); return {} },
    del: async (id, data) => { stripeCalls.push(['items.del', id, data]); return {} },
  },
  prices: { create: async (data) => { stripeCalls.push(['prices.create', data]); return { id: 'price_extra' } } },
}
const stripePath = require.resolve('../lib/stripe')
require.cache[stripePath] = {
  id: stripePath, filename: stripePath, loaded: true,
  exports: { getStripe: () => fakeStripe, isLiveMode: () => false, siteUrl: () => 'https://lsbookers.test', stripeUnavailable: () => {} },
}

const prisma = require('../prisma/client')
const { clearPlanSettingsCache } = require('../lib/planSettings')
const { getPlan } = require('../lib/plan')
const agency = require('../services/agency')
const billing = require('../services/billing')

async function withMocks(mocks, fn) {
  const base = {
    adminSettings: { findUnique: async () => null },
    notification: { create: async () => ({}) },
  }
  const all = { ...base, ...mocks }
  const originals = []
  for (const [model, methods] of Object.entries(all)) {
    for (const [name, impl] of Object.entries(methods)) {
      originals.push([model, name, prisma[model][name]])
      prisma[model][name] = impl
    }
  }
  clearPlanSettingsCache()
  stripeCalls.length = 0
  try {
    return await fn()
  } finally {
    for (const [model, name, original] of originals) prisma[model][name] = original
    clearPlanSettingsCache()
  }
}

const ACTIVE_AGENCY = { id: 3, userId: 1, status: 'ACTIVE', stripeSubId: 'sub_agence', extraProfiles: 0, stripeExtraItemId: null, interval: 'MONTH' }

// ── Qui est Pro ────────────────────────────────────────────

test('compte normal : ni Pro, ni géré (rien ne change)', async () => {
  await withMocks({
    subscription: { findUnique: async () => null },
    agencySubscription: { findUnique: async () => null },
    user: { findUnique: async () => ({ canManageProfiles: false }) },
    profileManager: { findMany: async () => [] },
  }, async () => {
    const plan = await getPlan({ id: 9, role: 'ARTIST' })
    assert.equal(plan.isPro, false)
    assert.equal(plan.managedPro, false)
  })
})

test('abonné Pro : toujours Pro (rien ne change)', async () => {
  await withMocks({
    subscription: { findUnique: async () => ({ status: 'ACTIVE', source: 'STRIPE' }) },
    agencySubscription: { findUnique: async () => null },
    user: { findUnique: async () => ({ canManageProfiles: false }) },
    profileManager: { findMany: async () => { throw new Error('inutile pour un abonné') } },
  }, async () => {
    assert.equal((await getPlan({ id: 9, role: 'ARTIST' })).isPro, true)
  })
})

test('formule Agence en cours : le compte de l’agence est Pro', async () => {
  await withMocks({
    subscription: { findUnique: async () => null },
    agencySubscription: { findUnique: async () => ACTIVE_AGENCY },
    user: { findUnique: async () => ({ canManageProfiles: false }) },
  }, async () => {
    assert.equal((await getPlan({ id: 1, role: 'ORGANIZER' })).isPro, true)
  })
})

test('profil géré par une agence qui a la formule : Pro', async () => {
  await withMocks({
    subscription: { findUnique: async () => null },
    agencySubscription: { findUnique: async () => null },
    user: { findUnique: async () => ({ canManageProfiles: false }) },
    profileManager: { findMany: async () => [{ profile: { userId: 9 } }] },
  }, async () => {
    const plan = await getPlan({ id: 9, role: 'ARTIST' })
    assert.equal(plan.isPro, true)
    assert.equal(plan.managedPro, true)
  })
})

// ── Places et profils en plus ──────────────────────────────

function slotMocks({ used, agencyRow = ACTIVE_AGENCY, offered = false, updates = [] }) {
  return {
    agencySubscription: {
      findUnique: async () => agencyRow,
      update: async ({ data }) => { updates.push(data); return { ...agencyRow, ...data } },
    },
    user: { findUnique: async () => ({ canManageProfiles: offered }) },
    profileManager: { count: async () => used },
  }
}

test('place libre (4 sur 5) : rien à payer', async () => {
  await withMocks(slotMocks({ used: 4 }), async () => {
    const slots = await agency.reserveSlot(1)
    assert.equal(slots.included, 5)
    assert.equal(stripeCalls.length, 0)
  })
})

test('6e profil sans accord : on demande de confirmer le profil en plus (2,99 €/mois)', async () => {
  await withMocks(slotMocks({ used: 5 }), async () => {
    await assert.rejects(agency.reserveSlot(1), (err) => {
      assert.equal(err.code, 'EXTRA_PROFILE_REQUIRED')
      assert.equal(err.status, 402)
      assert.equal(err.extraPriceCents, 299)
      return true
    })
    assert.equal(stripeCalls.length, 0)
  })
})

test('6e profil accepté : un profil en plus ajouté à la facture, au prorata', async () => {
  const updates = []
  await withMocks(slotMocks({ used: 5, updates }), async () => {
    await agency.reserveSlot(1, { acceptExtra: true })
    const price = stripeCalls.find(c => c[0] === 'prices.create')[1]
    assert.equal(price.unit_amount, 299)
    const item = stripeCalls.find(c => c[0] === 'items.create')[1]
    assert.equal(item.quantity, 1)
    assert.equal(item.proration_behavior, 'create_prorations')
    assert.deepEqual(updates[0], { extraProfiles: 1, stripeExtraItemId: 'si_extra' })
  })
})

test('une place se libère : le profil en plus est retiré de la facture', async () => {
  const updates = []
  await withMocks(slotMocks({ used: 5, agencyRow: { ...ACTIVE_AGENCY, extraProfiles: 1, stripeExtraItemId: 'si_extra' }, updates }), async () => {
    await agency.releaseSlots(1)
    assert.equal(stripeCalls[0][0], 'items.del')
    assert.deepEqual(updates[0], { extraProfiles: 0, stripeExtraItemId: null })
  })
})

test('formule offerte par l’admin : pas de limite de profils', async () => {
  await withMocks(slotMocks({ used: 40, agencyRow: null, offered: true }), async () => {
    const slots = await agency.reserveSlot(1)
    assert.equal(slots.unlimited, true)
  })
})

// ── Pro propre de l'artiste : suspendu puis repris ─────────

test('l’artiste rejoint l’agence : ses prélèvements Pro sont suspendus, avec une notification', async () => {
  const subUpdates = []
  const notifs = []
  await withMocks({
    subscription: {
      findUnique: async () => ({ id: 8, status: 'ACTIVE', source: 'STRIPE', stripeSubId: 'sub_pro_artiste', pausedByAgency: false }),
      update: async ({ data }) => { subUpdates.push(data); return {} },
    },
    user: { findUnique: async () => ({ email: null, notifPrefs: null }) },
    notification: { create: async ({ data }) => { notifs.push(data); return {} } },
  }, async () => {
    await agency.pauseOwnPro(9, 'Sud Booking')
    assert.deepEqual(stripeCalls[0], ['subscriptions.update', 'sub_pro_artiste', { pause_collection: { behavior: 'void' } }])
    assert.deepEqual(subUpdates[0], { pausedByAgency: true })
    assert.match(notifs[0].content, /suspendus/)
  })
})

test('fin de la collaboration : l’abonnement Pro de l’artiste reprend tout seul', async () => {
  const subUpdates = []
  await withMocks({
    subscription: {
      findUnique: async () => ({ id: 8, status: 'ACTIVE', source: 'STRIPE', stripeSubId: 'sub_pro_artiste', pausedByAgency: true }),
      update: async ({ data }) => { subUpdates.push(data); return {} },
    },
    user: { findUnique: async () => ({ email: null, notifPrefs: null }) },
  }, async () => {
    await agency.resumeOwnPro(9)
    assert.deepEqual(stripeCalls[0], ['subscriptions.update', 'sub_pro_artiste', { pause_collection: '' }])
    assert.deepEqual(subUpdates[0], { pausedByAgency: false })
  })
})

test('Pro offert (Fondateur) : jamais suspendu', async () => {
  await withMocks({
    subscription: { findUnique: async () => ({ id: 8, status: 'ACTIVE', source: 'FOUNDER', stripeSubId: null, pausedByAgency: false }) },
  }, async () => {
    await agency.pauseOwnPro(9, 'Sud Booking')
    assert.equal(stripeCalls.length, 0)
  })
})

// ── Abonnement Stripe ──────────────────────────────────────

const stripeSub = (metadata) => ({
  id: 'sub_new', status: 'active', metadata, start_date: 1790000000, current_period_end: 1792000000,
  items: { data: [{ id: 'si_base', current_period_end: 1792000000, price: { unit_amount: 3499, recurring: { interval: 'month' } } }] },
})

test('abonnement Pro : enregistré comme avant (rien ne change)', async () => {
  const upserts = []
  await withMocks({
    subscription: { findUnique: async () => null, upsert: async (args) => { upserts.push(args); return {} } },
    agencySubscription: { upsert: async () => { throw new Error('ne doit pas toucher à l’Agence') } },
    user: { update: async () => ({}) },
  }, async () => {
    await billing.syncStripeSubscription(stripeSub({ userId: '9' }))
    assert.equal(upserts.length, 1)
    assert.equal(upserts[0].update.plan, 'PRO')
  })
})

test('abonné Pro qui passe à l’Agence : l’Agence est enregistrée, le Pro arrêté au prorata', async () => {
  const agencyUpserts = []
  await withMocks({
    agencySubscription: { findUnique: async () => null, upsert: async (args) => { agencyUpserts.push(args); return {} } },
    subscription: { findUnique: async () => ({ id: 8, status: 'ACTIVE', source: 'STRIPE', stripeSubId: 'sub_pro' }), upsert: async () => { throw new Error('le Pro ne doit pas être écrasé') } },
    user: { update: async () => ({}), findUnique: async () => ({ canManageProfiles: false, pseudo: 'Sud Booking' }), findFirst: async () => ({ id: 1 }) },
    profileManager: { findMany: async () => [] },
  }, async () => {
    await billing.syncStripeSubscription(stripeSub({ userId: '1', plan: 'AGENCY' }))
    assert.equal(agencyUpserts.length, 1)
    assert.equal(agencyUpserts[0].update.status, 'ACTIVE')
    assert.equal(agencyUpserts[0].update.priceCents, 3499)
    assert.deepEqual(stripeCalls.find(c => c[0] === 'subscriptions.cancel'), ['subscriptions.cancel', 'sub_pro', { prorate: true, invoice_now: true }])
  })
})

test('Fondateur qui prend l’Agence : son Pro offert reste intact', async () => {
  await withMocks({
    agencySubscription: { findUnique: async () => null, upsert: async () => ({}) },
    subscription: { findUnique: async () => ({ id: 8, status: 'ACTIVE', source: 'FOUNDER', stripeSubId: null }) },
    user: { update: async () => ({}), findUnique: async () => ({ canManageProfiles: false }), findFirst: async () => ({ id: 1 }) },
    profileManager: { findMany: async () => [] },
  }, async () => {
    await billing.syncStripeSubscription(stripeSub({ userId: '1', plan: 'AGENCY' }))
    assert.equal(stripeCalls.filter(c => c[0] === 'subscriptions.cancel').length, 0)
  })
})
