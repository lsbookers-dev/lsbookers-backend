// lib/managerLog.js — Journal de l'agence : chaque action réussie d'une agence pour un profil géré
// est notée (booking accepté, demande envoyée, candidature, publication…). L'agence et l'artiste
// le voient (« booking accepté pour Nina par Sud Booking »). Les messages n'y sont pas : trop nombreux.
const prisma = require('../prisma/client')

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const BOOKING_STATUS = { ACCEPTED: 'BOOKING_ACCEPTED', DECLINED: 'BOOKING_DECLINED', CANCELLED: 'BOOKING_CANCELLED' }

// [méthode, chemin, action (ou fonction qui la choisit)]
const RULES = [
  ['PATCH', /^\/api\/events\/booking-request\/(\d+)$/, (req) => {
    const status = BOOKING_STATUS[req.body?.status]
    if (status === 'BOOKING_ACCEPTED' && req.management?.requireApproval) return 'BOOKING_APPROVAL_REQUESTED'
    return status || null
  }],
  ['POST', /^\/api\/events\/booking-request$/, 'BOOKING_REQUEST_SENT'],
  ['POST', /^\/api\/events\/booking-request\/(\d+)\/cancel-request$/, 'BOOKING_CANCEL_REQUESTED'],
  ['POST', /^\/api\/offers\/(\d+)\/apply$/, 'OFFER_APPLICATION'],
  ['POST', /^\/api\/offers$/, 'OFFER_PUBLISHED'],
  ['POST', /^\/api\/publications$/, 'PUBLICATION'],
  ['POST', /^\/api\/events$/, 'EVENT_CREATED'],
  ['PUT', /^\/api\/profile\/[^/]+$/, 'PROFILE_UPDATED'],
]

function matchRule(req) {
  const path = String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '')
  for (const [method, pattern, action] of RULES) {
    if (method !== req.method) continue
    const m = pattern.exec(path)
    if (!m) continue
    const name = typeof action === 'function' ? action(req) : action
    return name ? { action: name, id: m[1] ? Number(m[1]) : null } : null
  }
  return null
}

// Un détail lisible (« du 14 novembre avec Le Rex ») pour les bookings et candidatures
async function detailFor(action, id, req) {
  if (action.startsWith('BOOKING') && id) {
    const br = await prisma.bookingRequest.findUnique({
      where: { id },
      select: { startDate: true, requester: { select: { user: { select: { pseudo: true, firstName: true, lastName: true } } } } },
    })
    if (!br) return null
    const who = br.requester?.user?.pseudo || [br.requester?.user?.firstName, br.requester?.user?.lastName].filter(Boolean).join(' ')
    const day = new Date(br.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' })
    return `du ${day}${who ? ` avec ${who}` : ''}`
  }
  if (action === 'OFFER_APPLICATION' && id) {
    const offer = await prisma.offer.findUnique({ where: { id }, select: { title: true } })
    return offer ? `« ${offer.title} »` : null
  }
  if (action === 'OFFER_PUBLISHED' || action === 'EVENT_CREATED') return req.body?.title ? `« ${String(req.body.title).slice(0, 80)} »` : null
  return null
}

/** Middleware : à placer avant les routes ; n'agit que pour une agence qui agit pour un profil géré */
function logManagedActions(req, res, next) {
  if (!WRITES.has(req.method)) return next()
  res.on('finish', () => {
    if (!req.actor || !req.management || res.statusCode >= 400) return
    const rule = matchRule(req)
    if (!rule) return
    ;(async () => {
      // Profil modifié plusieurs fois de suite : une seule ligne par heure
      if (rule.action === 'PROFILE_UPDATED') {
        const recent = await prisma.managerActionLog.findFirst({
          where: { profileId: req.management.profileId, action: 'PROFILE_UPDATED', createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
          select: { id: true },
        })
        if (recent) return
      }
      await prisma.managerActionLog.create({
        data: {
          managerUserId: req.actor.id,
          profileId: req.management.profileId,
          action: rule.action,
          detail: await detailFor(rule.action, rule.id, req).catch(() => null),
        },
      })
    })().catch(err => console.error('Journal de l’agence :', err.message))
  })
  next()
}

/** Dernières lignes du journal, pour l'agence (tous ses profils) ou pour un profil */
async function journal({ managerUserId, profileId, take = 30 }) {
  return prisma.managerActionLog.findMany({
    where: { ...(managerUserId ? { managerUserId } : {}), ...(profileId ? { profileId } : {}) },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, managerUserId: true, profileId: true, action: true, detail: true, createdAt: true },
  })
}

module.exports = { logManagedActions, matchRule, journal }
