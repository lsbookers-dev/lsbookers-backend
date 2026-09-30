const test = require('node:test')
const assert = require('node:assert/strict')
const { setSessionCookie, isSameSiteRequest, tokenFromCookieHeader } = require('../lib/session')

const req = (origin, hostname, secure = true) => ({ headers: { origin }, hostname, secure })

test('même site (lsbookers.com → api.lsbookers.com) : mode cookie uniquement', () => {
  assert.equal(isSameSiteRequest(req('https://lsbookers.com', 'api.lsbookers.com')), true)
  assert.equal(isSameSiteRequest(req('https://www.lsbookers.com', 'api.lsbookers.com')), true)
  assert.equal(isSameSiteRequest(req('http://localhost:3000', 'localhost')), true)
})

test('autre site (lsbookers.com → railway.app) : mode transition (jeton renvoyé)', () => {
  assert.equal(isSameSiteRequest(req('https://lsbookers.com', 'lsbookers-backend-production.up.railway.app')), false)
  assert.equal(isSameSiteRequest(req('http://localhost:3000', '127.0.0.1')), false)
  assert.equal(isSameSiteRequest(req(undefined, 'api.lsbookers.com')), false)
})

test('cookie de session : httpOnly, SameSite=Lax (jamais None), Secure en HTTPS', () => {
  let captured
  const res = { cookie: (name, value, opts) => { captured = { name, value, opts } } }
  setSessionCookie(req('https://lsbookers.com', 'api.lsbookers.com', true), res, 'jwt')
  assert.equal(captured.name, 'token')
  assert.equal(captured.opts.httpOnly, true)
  assert.equal(captured.opts.sameSite, 'lax')
  assert.equal(captured.opts.secure, true)
})

test('lecture du cookie token dans la poignée de main du socket', () => {
  assert.equal(tokenFromCookieHeader('a=1; token=abc.def.ghi; b=2'), 'abc.def.ghi')
  assert.equal(tokenFromCookieHeader('a=1'), null)
  assert.equal(tokenFromCookieHeader(undefined), null)
})
