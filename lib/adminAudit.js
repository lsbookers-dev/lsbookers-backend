// lib/adminAudit.js — Enregistre dans le journal admin chaque action réussie de l'admin
// (tout ce qui n'est pas une simple lecture), sans avoir à l'écrire dans chaque route.
// Monté dans server.js devant /api/admin et /api/contact/admin.

const { logAdmin, labelForUser } = require('./adminLog')

// [méthode, chemin (sous /api/admin ou /api/contact/admin), action]
const ACTIONS = [
  ['PATCH', /^\/users\/(\d+)\/role$/, 'USER_ROLE'],
  ['PATCH', /^\/users\/(\d+)\/manage-profiles$/, 'GIFT_BUSINESS'],
  ['DELETE', /^\/users\/(\d+)$/, 'USER_DELETE'],
  ['POST', /^\/billing\/users\/(\d+)\/gift-pro$/, 'GIFT_PRO'],
  ['DELETE', /^\/billing\/users\/(\d+)\/gift-pro$/, 'GIFT_PRO_REMOVE'],
  ['POST', /^\/billing\/users\/(\d+)\/ban$/, 'USER_BAN'],
  ['POST', /^\/billing\/users\/(\d+)\/unban$/, 'USER_UNBAN'],
  ['PUT', /^\/billing\/settings$/, 'PLAN_SETTINGS'],
  ['POST', /^\/billing\/promo-codes$/, 'PROMO_CREATE'],
  ['PATCH', /^\/billing\/promo-codes\/\d+$/, 'PROMO_UPDATE'],
  ['POST', /^\/billing\/extras$/, 'EXTRA_CREATE'],
  ['PUT', /^\/billing\/extras\/\d+$/, 'EXTRA_UPDATE'],
  ['POST', /^\/billing\/orders\/\d+\/validate$/, 'ORDER_VALIDATE'],
  ['POST', /^\/billing\/orders\/\d+\/refuse$/, 'ORDER_REFUSE'],
  ['PUT', /^\/settings\/?$/, 'SITE_SETTINGS'],
  ['POST', /^\/posts\/?$/, 'POST_CREATE'],
  ['DELETE', /^\/posts\/\d+$/, 'POST_DELETE'],
  ['PATCH', /^\/posts\/\d+\/toggle$/, 'POST_TOGGLE'],
  ['PATCH', /^\/posts\/\d+\/pin$/, 'POST_PIN'],
  ['POST', /^\/featured\/?$/, 'FEATURED_ADD'],
  ['PUT', /^\/featured\/order$/, 'FEATURED_ORDER'],
  ['PATCH', /^\/featured\/\d+$/, 'FEATURED_UPDATE'],
  ['DELETE', /^\/featured\/\d+$/, 'FEATURED_DELETE'],
  ['PATCH', /^\/contact\/\d+\/archive$/, 'CONTACT_ARCHIVE'],
  ['DELETE', /^\/contact\/\d+$/, 'CONTACT_DELETE'],
]
// Simple lecture d'un message de contact : pas une action à garder
const IGNORED = [['PATCH', /^\/contact\/\d+\/read$/]]

const SECRET_KEY = /password|token|secret|code_hash/i

/** Contenu de la demande, sans rien de secret et de taille raisonnable */
function safeDetails(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) && !body.length) return null
  const clean = JSON.parse(JSON.stringify(body, (key, value) => (key && SECRET_KEY.test(key) ? undefined : value)))
  if (!clean || !Object.keys(clean).length) return null
  const text = JSON.stringify(clean)
  return text.length <= 3000 ? clean : { trop_long: true, champs: Object.keys(clean).slice(0, 30) }
}

function matchAction(method, path) {
  if (IGNORED.some(([m, re]) => m === method && re.test(path))) return null
  for (const [m, re, action] of ACTIONS) {
    const found = m === method && path.match(re)
    if (found) return { action, targetUserId: found[1] ? Number(found[1]) : null }
  }
  return { action: 'ADMIN_ACTION', targetUserId: null }
}

/** `prefix` : '' pour /api/admin, '/contact' pour /api/contact/admin */
function adminAudit(prefix = '') {
  return async (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
    const path = `${prefix}${req.path}`.replace(/\/+$/, '') || '/'
    const found = matchAction(req.method, path)
    if (!found) return next()
    // Nom du compte visé lu AVANT l'action (il n'existe plus après une suppression)
    const targetLabel = found.targetUserId ? await labelForUser(found.targetUserId) : null
    const details = safeDetails(req.body)
    res.on('finish', () => {
      if (res.statusCode >= 400 || String(req.user?.role || '').toUpperCase() !== 'ADMIN') return
      logAdmin(req, found.action, {
        targetUserId: found.targetUserId,
        targetLabel,
        details: found.action === 'ADMIN_ACTION' ? { ...(details || {}), route: `${req.method} ${path}` } : details,
      })
    })
    next()
  }
}

module.exports = { adminAudit, matchAction, safeDetails }
