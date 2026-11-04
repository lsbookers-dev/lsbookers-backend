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

// Compte admin (31/10/2026) : session ouverte seulement après le code reçu par e-mail (jeton « adm »),
// fermée après 1 h sans activité et dans tous les cas 6 h après la connexion.
const ADMIN_SESSION_MAX_MS = 6 * 60 * 60 * 1000
const ADMIN_IDLE_MS = 60 * 60 * 1000
const ADMIN_TOUCH_EVERY_MS = 60 * 1000
const isAdminRole = (user) => String(user?.role || '').toUpperCase() === 'ADMIN'

// Membres (04/11/2026) : la connexion dure 30 jours et se prolonge toute seule quand on utilise le site
// (jeton renouvelé au plus une fois par jour). Avant : 7 jours fixes, puis reconnexion obligatoire.
const SESSION_TTL = '30d'
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

/** Système de l'appareil : « iPhone », « Mac »… (null si inconnu) */
function osFromUA(ua = '') {
  const s = String(ua)
  return /iPhone/i.test(s) ? 'iPhone' :
    /iPad/i.test(s) ? 'iPad' :
    /Android/i.test(s) ? 'Android' :
    /Windows/i.test(s) ? 'Windows' :
    /Mac OS X|Macintosh/i.test(s) ? 'Mac' :
    /Linux/i.test(s) ? 'Linux' : null
}

/** « Safari sur iPhone », « Chrome sur Mac »… ; l'application installée : « Application LS Bookers sur iPhone » */
function deviceNameFromUA(ua = '', { standalone = false } = {}) {
  const s = String(ua)
  const os = osFromUA(s)
  if (standalone) return os ? `Application LS Bookers sur ${os}` : 'Application LS Bookers'
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

function signToken(user, sid, { admin = false } = {}) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, isAdmin: user.isAdmin, tokenVersion: user.tokenVersion, sid, ...(admin ? { adm: true } : {}) },
    process.env.JWT_SECRET,
    { expiresIn: admin ? '6h' : SESSION_TTL }
  )
}

/**
 * Ouvre une session : nouvelle (connexion) ou existante (`sid`, après un changement de mot de passe
 * qui a fait évoluer tokenVersion). Pose le cookie de session et renvoie le jeton.
 * `isNewDevice` : cet appareil ne s'était jamais connecté à ce compte (alerte de connexion).
 * `admin` : session admin ouverte après le code de sécurité (seul routes/auth.js › admin-code le passe).
 */
async function issueSession(req, res, user, { sid, admin = false, deviceHint = null, standalone = false } = {}) {
  if (sid) {
    // Session existante (déjà vérifiée par requireAuth) : un admin garde sa session admin
    const keepAdmin = isAdminRole(user)
    const token = signToken(user, sid, { admin: keepAdmin })
    setSessionCookie(req, res, token, keepAdmin ? ADMIN_SESSION_MAX_MS : undefined)
    return { token, sid, isNewDevice: false }
  }

  const deviceId = ensureDeviceId(req, res)
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 300) || null
  const hint = typeof deviceHint === 'string' && HINT_RE.test(deviceHint) ? deviceHint.toLowerCase() : null
  const name = deviceNameFromUA(userAgent || '', { standalone })
  // Appareil déjà connu : même cookie « appareil », OU même identifiant gardé par le site
  // (Safari peut effacer le cookie au bout de 7 jours ; l'identifiant du site, lui, reste)
  const [known, previous] = await Promise.all([
    prisma.userSession.findFirst({
      where: { userId: user.id, OR: [{ deviceId }, ...(hint ? [{ deviceHint: hint }] : [])] },
      select: { id: true },
    }),
    prisma.userSession.count({ where: { userId: user.id } }),
  ])
  let isNewDevice = !known && previous > 0 // première connexion du compte : rien à signaler
  // Application installée sur un téléphone déjà connecté (même système, connexion encore active) :
  // c'est le membre qui vient d'installer l'appli, pas un inconnu
  const os = osFromUA(userAgent || '')
  if (isNewDevice && standalone && os) {
    const sameDevice = await prisma.userSession.findFirst({
      where: { userId: user.id, revokedAt: null, name: { endsWith: `sur ${os}` }, lastUsedAt: { gte: new Date(Date.now() - SESSION_LIFETIME_MS) } },
      select: { id: true },
    })
    if (sameDevice) isNewDevice = false
  }
  const newSid = crypto.randomBytes(24).toString('hex')
  await prisma.userSession.create({
    data: { userId: user.id, sid: newSid, deviceId, deviceHint: hint, name, userAgent },
  })
  const token = signToken(user, newSid, { admin })
  setSessionCookie(req, res, token, admin ? ADMIN_SESSION_MAX_MS : undefined)
  return { token, sid: newSid, isNewDevice, deviceName: name }
}

// Identifiant d'appareil du site (localStorage, en-tête X-Device-Token) : un UUID
const HINT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Connexion prolongée : un membre qui utilise le site reçoit un nouveau jeton de 30 jours (même session),
 * au plus une fois par jour. Seulement quand la session est portée par le cookie (mode du site en ligne).
 * Jamais pour l'admin (1 h sans activité, 6 h au plus).
 */
function renewSessionIfDue(req, res, { decoded, user, sid, fromCookie }) {
  if (!fromCookie || !sid || !decoded?.iat || isAdminRole(user)) return false
  if (Date.now() - decoded.iat * 1000 < RENEW_AFTER_MS) return false
  setSessionCookie(req, res, signToken(user, sid))
  return true
}

/** Met à jour « dernière activité » sans ralentir la requête (au plus toutes les 10 min, 1 min pour l'admin) */
function touchSession(session, everyMs = TOUCH_EVERY_MS) {
  if (!session || Date.now() - new Date(session.lastUsedAt).getTime() < everyMs) return
  prisma.userSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } }).catch(() => {})
}

/**
 * Session admin encore valable ? Renvoie null, ou la raison du refus (la session est alors fermée).
 * `session` : { id, createdAt, lastUsedAt, revokedAt } ; `decoded` : contenu du jeton.
 */
function adminSessionProblem(decoded, session, now = Date.now()) {
  if (!decoded?.adm || !session) return 'ADMIN_CODE_REQUIRED'
  if (now - new Date(session.createdAt).getTime() > ADMIN_SESSION_MAX_MS) return 'ADMIN_SESSION_EXPIRED'
  if (now - new Date(session.lastUsedAt).getTime() > ADMIN_IDLE_MS) return 'ADMIN_SESSION_EXPIRED'
  return null
}

function revokeSession(session) {
  if (!session?.id) return Promise.resolve()
  return prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } }).catch(() => {})
}

module.exports = {
  issueSession, touchSession, deviceNameFromUA, osFromUA, renewSessionIfDue, DEVICE_COOKIE, SESSION_LIFETIME_MS,
  adminSessionProblem, revokeSession, ADMIN_SESSION_MAX_MS, ADMIN_IDLE_MS, ADMIN_TOUCH_EVERY_MS,
}
