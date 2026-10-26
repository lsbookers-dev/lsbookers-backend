const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secret-de-test'
const { memberOrIp, ipAndEmail } = require('../lib/rateLimitKeys')

const token = (payload, secret = process.env.JWT_SECRET) => jwt.sign(payload, secret, { expiresIn: '1h' })

test('limites : un membre connecté compte pour lui-même, pas pour sa connexion internet', () => {
  const ip = '203.0.113.7'
  assert.equal(memberOrIp({ ip, headers: { authorization: `Bearer ${token({ id: 12 })}` } }), 'u:12')
  assert.equal(memberOrIp({ ip, headers: { cookie: `theme=dark; token=${token({ id: 34 })}` } }), 'u:34')
  // Deux membres sur le même wifi : deux compteurs différents
  assert.notEqual(
    memberOrIp({ ip, headers: { authorization: `Bearer ${token({ id: 1 })}` } }),
    memberOrIp({ ip, headers: { authorization: `Bearer ${token({ id: 2 })}` } }),
  )
})

test('limites : jeton absent, faux ou expiré → compté par adresse IP', () => {
  const ip = '198.51.100.1'
  assert.equal(memberOrIp({ ip, headers: {} }), `ip:${ip}`)
  assert.equal(memberOrIp({ ip, headers: { authorization: 'Bearer null' } }), `ip:${ip}`)
  assert.equal(memberOrIp({ ip, headers: { authorization: `Bearer ${token({ id: 5 }, 'autre-secret')}` } }), `ip:${ip}`)
  const expired = jwt.sign({ id: 5, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET)
  assert.equal(memberOrIp({ ip, headers: { authorization: `Bearer ${expired}` } }), `ip:${ip}`)
})

test('limites de connexion : par adresse IP et par e-mail visé', () => {
  const ip = '192.0.2.4'
  assert.equal(ipAndEmail({ ip, body: { email: ' Antho@LSBookers.com ' } }), `ip:${ip}|antho@lsbookers.com`)
  assert.notEqual(ipAndEmail({ ip, body: { email: 'a@x.fr' } }), ipAndEmail({ ip, body: { email: 'b@x.fr' } }))
  assert.equal(ipAndEmail({ ip, body: {} }), `ip:${ip}|`)
})
