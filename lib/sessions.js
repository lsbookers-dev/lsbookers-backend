// lib/sessions.js — Sessions de connexion (un appareil = une session), listées et révocables
// depuis Réglages › Connexion et sécurité.
//
// Le jeton JWT porte un identifiant de session (sid). Une session révoquée (appareil retiré,
// déconnexion) est refusée par middleware/auth.js. « Se déconnecter partout » incrémente en plus
// tokenVersion, ce qui invalide aussi les anciens jetons émis avant les sessions.

const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const prisma = require('../prisma/client')
const { setSessionCookie } = require('./session')

const DEVICE_COOKIE = 'lsb_device'
const DEVICE_MAX_AGE = 400 * 24 * 60 * 60 * 1000 // ~13 mois
const TOUCH_EVERY_MS = 10 * 60 * 1000          // « Dernière activité » mise à jour au plus toutes les 10 min

/** « Safari sur iPhone », « Chrome sur Mac »… à partir de l'en-tête User-Agent */
function deviceNameFromUA(ua = '') {
  const s = String(ua)
  const os =
    /iPhone/i.test(s) ? 'iPhone' :
    /iPad/i.test(s) ? 'iPad' :
    /Android/i.test(s) ? 'Android' :
    /Windows/i.test(s) ? 'Windows' :
    /Mac OS X|Macintosh/i.test(s) ? 'Mac' :
    /Linux/i.test(s) ? 'Linux' : null
  const browser =
    /Edg\//i.test(s) ? 'Edge' :
    /OPR\/|Opera/i.test(s) ? 'Opera' :
    /Firefox\//i.test(s) ? 'Firefox' :
    /SamsungBrowser/i.test(s) ? 'Samsung Internet' :
    /Chrome\/|CriOS/i.test(s) ? 'Chrome' :
    /Safari\//i.test(s) ? 'Safari' : null
  if (browser && os) return `${browser} sur ${os}`
  return browser || os || 'Appareil inconnu'
}

function deviceCookieOptions(req) {
  return { httpOnly: true, secure: !!req.secure, sameSite: 'lax', path: '/', maxAge: DEVICE_MAX_AGE }
}

/** Identifiant durable de l'appareil (créé au besoin) */
function ensureDeviceId(req, res) {
  const existing = req.cookies?.[DEVICE_COOKIE]
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing
  const id = crypto.randomBytes(16).toString('hex')
  res.cookie(DEVICE_COOKIE, id, deviceCookieOptions(req))
  return id
}

function signToken(user, sid) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, isAdmin: user.isAdmin, tokenVersion: user.tokenVersion, sid },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  )
}

/**
 * Ouvre une session : nouvelle (connexion) ou existante (`sid`, après un changement de mot de passe
 * qui a fait évoluer tokenVersion). Pose le cookie de session et renvoie le jeton.
 * `isNewDevice` : cet appareil ne s'était jamais connecté à ce compte (alerte de connexion).
 */
async function issueSession(req, res, user, { sid } = {}) {
  if (sid) {
    const token = signToken(user, sid)
    setSessionCookie(req, res, token)
    return { token, sid, isNewDevice: false }
  }

  const deviceId = ensureDeviceId(req, res)
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 300) || null
  const [known, previous] = await Promise.all([
    prisma.userSession.findFirst({ where: { userId: user.id, deviceId }, select: { id: true } }),
    prisma.userSession.count({ where: { userId: user.id } }),
  ])
  const newSid = crypto.randomBytes(24).toString('hex')
  await prisma.userSession.create({
    data: { userId: user.id, sid: newSid, deviceId, name: deviceNameFromUA(userAgent || ''), userAgent },
  })
  const token = signToken(user, newSid)
  setSessionCookie(req, res, token)
  // Première connexion du compte : pas d'alerte (rien à signaler)
  return { token, sid: newSid, isNewDevice: !known && previous > 0, deviceName: deviceNameFromUA(userAgent || '') }
}

/** Met à jour « dernière activité » sans ralentir la requête (au plus toutes les 10 min) */
function touchSession(session) {
  if (!session || Date.now() - new Date(session.lastUsedAt).getTime() < TOUCH_EVERY_MS) return
  prisma.userSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } }).catch(() => {})
}

module.exports = { issueSession, touchSession, deviceNameFromUA, DEVICE_COOKIE }
