// lib/managedProfiles.js — Profils gérés (agent d'artistes, plusieurs salles)
//
// L'agent garde son propre compte. Quand il choisit un profil dans le sélecteur
// « Vous agissez en tant que », le site envoie l'en-tête X-Act-As-Profile : le serveur
// vérifie la fiche de gestion puis traite la requête avec le compte du profil géré
// (req.user), l'agent restant connu dans req.actor. Sans cet en-tête, rien ne change.

const crypto = require('crypto')
const prisma = require('../prisma/client')

const ACT_AS_HEADER = 'x-act-as-profile'
const INVITE_DAYS = 14
const MAX_PENDING_INVITES = 10

// Ce que l'agent ne peut jamais faire à la place du titulaire du compte :
// identifiants, suppression, appareils, réglages du compte, abonnement, argent.
const BLOCKED_WHILE_ACTING = [
  { prefix: '/api/account' },
  { prefix: '/api/auth', except: ['GET /api/auth/me', 'POST /api/auth/logout', 'POST /api/auth/heartbeat'] },
  { prefix: '/api/profile/me/account' },
  { prefix: '/api/billing', onlyWrites: true },
  { prefix: '/api/payouts', onlyWrites: true },
  { prefix: '/api/booking-payments', onlyWrites: true },
  { prefix: '/api/admin' },
]

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** true si cette requête est interdite en mode « agir en tant que » */
function isBlockedWhileActing(method, url) {
  const path = String(url || '').split('?')[0].replace(/\/+$/, '')
  const verb = String(method || 'GET').toUpperCase()
  return BLOCKED_WHILE_ACTING.some(rule => {
    if (path !== rule.prefix && !path.startsWith(`${rule.prefix}/`)) return false
    if (rule.except?.includes(`${verb} ${path}`)) return false
    if (rule.onlyWrites) return WRITE_METHODS.has(verb)
    return true
  })
}

/** Numéro de profil demandé dans l'en-tête, ou null */
function requestedProfileId(req) {
  const raw = req.headers?.[ACT_AS_HEADER]
  const id = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** Fiche de gestion active entre ce compte et ce profil (ou null) */
async function findActiveManagement(managerUserId, profileId) {
  return prisma.profileManager.findFirst({
    where: { managerUserId, profileId, status: 'ACTIVE' },
    select: { id: true, profileId: true, requireApproval: true, profile: { select: { userId: true } } },
  })
}

// Données personnelles du titulaire que l'agent ne voit pas (e-mail, téléphone, naissance, Stripe…)
const PRIVATE_USER_FIELDS = [
  'email', 'phone', 'dateOfBirth', 'stripeAccountId', 'stripeCustomerId', 'pendingEmail',
  'pendingEmailExpiresAt', 'notifPrefs', 'signupPlan', 'emailVerificationToken', 'password',
  'tokenVersion', 'requiresPasswordReset', 'pendingEmailTokenHash',
]
function hidePrivateFromManager(user) {
  if (!user) return user
  const out = { ...user }
  for (const key of PRIVATE_USER_FIELDS) delete out[key]
  return out
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')
const newInviteToken = () => crypto.randomBytes(32).toString('hex')
const inviteExpiry = () => new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000)

/** Message écrit par une agence pour un profil géré : on garde qui l'a vraiment écrit */
const sentByActor = (req) => (req?.actor ? { sentByUserId: req.actor.id } : {})

/** Nom affiché d'un compte (pseudo, sinon prénom nom) */
const accountName = (u) => u?.pseudo || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || 'Membre'

module.exports = {
  ACT_AS_HEADER,
  INVITE_DAYS,
  MAX_PENDING_INVITES,
  isBlockedWhileActing,
  requestedProfileId,
  findActiveManagement,
  hidePrivateFromManager,
  hashToken,
  newInviteToken,
  inviteExpiry,
  accountName,
  sentByActor,
}
