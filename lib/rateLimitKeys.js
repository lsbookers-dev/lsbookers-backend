// lib/rateLimitKeys.js — Qui compte pour les limites anti-abus (#278)
//
// Les limites comptaient par connexion internet (adresse IP) : sur le wifi d'un festival ou d'une
// salle, des dizaines de membres partagent la même adresse et se bloquaient entre eux.
// Désormais : par membre quand il est connecté, par adresse IP sinon.
const jwt = require('jsonwebtoken')
const { tokenFromCookieHeader } = require('./session')

// Jeton de session (en-tête Authorization puis cookie), vérifié sans aller en base :
// la limite passe avant la vérification complète du compte, elle doit rester instantanée.
function memberIdFrom(req) {
  const header = req.headers?.authorization
  const bearer = header && header.startsWith('Bearer ') ? header.slice(7) : null
  const token = (bearer && bearer !== 'null' && bearer !== 'undefined') ? bearer : tokenFromCookieHeader(req.headers?.cookie)
  if (!token) return null
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const id = Number(decoded.id || decoded.userId)
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

/** Membre connecté → « u:<id> », sinon l'adresse IP */
function memberOrIp(req) {
  const id = memberIdFrom(req)
  return id ? `u:${id}` : `ip:${req.ip}`
}

/** Connexion, inscription, mot de passe : adresse IP + e-mail visé (un e-mail par personne) */
function ipAndEmail(req) {
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200)
  return `ip:${req.ip}|${email}`
}

module.exports = { memberIdFrom, memberOrIp, ipAndEmail }
