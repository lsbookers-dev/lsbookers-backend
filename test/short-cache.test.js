// Petite mémoire de courte durée (audit du 18/11/2026)
const test = require('node:test')
const assert = require('node:assert/strict')
const { createShortCache } = require('../lib/shortCache')

test('mémoire courte : un seul calcul pour des demandes simultanées ou rapprochées', async () => {
  const cache = createShortCache({ ttlMs: 1000 })
  let runs = 0
  const load = async () => { runs++; return runs }
  const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)])
  assert.equal(a, 1); assert.equal(b, 1)
  assert.equal(await cache.get('k', load), 1)
  assert.equal(runs, 1)
})

test('mémoire courte : recalcul une fois la durée passée', async () => {
  const cache = createShortCache({ ttlMs: 20 })
  let runs = 0
  await cache.get('k', async () => ++runs)
  await new Promise(r => setTimeout(r, 30))
  assert.equal(await cache.get('k', async () => ++runs), 2)
})

test('mémoire courte : un échec n’est pas gardé, et la taille reste bornée', async () => {
  const cache = createShortCache({ ttlMs: 1000, max: 2 })
  await assert.rejects(cache.get('k', async () => { throw new Error('base indisponible') }))
  await new Promise(r => setImmediate(r))
  assert.equal(await cache.get('k', async () => 'ok'), 'ok')
  await cache.get('a', async () => 1)
  await cache.get('b', async () => 2)
  assert.equal(cache.size(), 2)
})
