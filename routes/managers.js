// routes/managers.js — Profils gérés (agent d'artistes, plusieurs salles)
// Monté dans server.js sous /api/managers
//
// Côté agent (compte avec canManageProfiles, même s'il agit pour un artiste : on utilise req.actor) :
//   GET    /profiles                  mes profils gérés et invitations en cours
//   GET    /candidates?q=             profils existants à inviter (recherche par nom)
//   POST   /invite        { profileId }   inviter un membre déjà inscrit
//   POST   /create        { email, pseudo, role, city?, specialties? }  préparer un profil pour quelqu'un
//   POST   /profiles/:id/resend       renvoyer l'invitation (nouveau lien de 14 jours)
//   DELETE /profiles/:id              arrêter la gestion / annuler l'invitation
// Côté titulaire du profil (jamais en mode « agir en tant que ») :
//   GET    /mine                      qui gère mon profil, invitations reçues
//   POST   /mine/:id/accept { requireApproval? }
//   POST   /mine/:id/decline
//   PATCH  /mine/:id      { requireApproval }
//   DELETE /mine/:id                  retirer l'accès
// Lien de l'e-mail (sans connexion pour un profil préparé, avec connexion sinon) :
//   GET    /claim/:token
//   POST   /claim/:token  { password, firstName, lastName, requireApproval?, isAdult }

const express = require('express')
const bcrypt = require('bcrypt')
const crypto = require('crypto')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth, optionalAuth } = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { managedCreateSchema, managedClaimSchema } = require('../schemas')
const { createNotif } = require('../services/notifications')
const { notifyAdmins } = require('../services/adminAlerts')
const {
  MAX_PENDING_INVITES, hashToken, newInviteToken, inviteExpiry, accountName,
} = require('../lib/managedProfiles')
const { hasAgency } = require('../lib/plan')
const agency = require('../services/agency')
const { agencyDashboard, agencyAgenda, managedProfiles, unreadByProfile } = require('../services/agencyDashboard')
const { journal } = require('../lib/managerLog')

// Refus lié à la formule Agence (places, profil en plus) : message clair pour le site
function sendAgencyError(res, err) {
  if (!(err instanceof agency.AgencyError)) return false
  const { code, message, status, extraPriceCents, interval, included, used } = err
  res.status(status).json({ error: code, message, extraPriceCents, interval, included, used })
  return true
}

// Module e-mail chargé à la demande (il exige la clé Resend, absente des tests)
const emails = () => require('../utils/email')

const PROFILE_SUMMARY = {
  id: true, avatar: true, location: true, specialties: true,
  user: { select: { id: true, pseudo: true, firstName: true, lastName: true, role: true } },
}

const isExpired = (m) => m.status === 'PENDING' && m.expiresAt && new Date(m.expiresAt) < new Date()

function summarizeProfile(profile) {
  if (!profile) return null
  return {
    id: profile.id,
    name: accountName(profile.user),
    avatar: profile.avatar || null,
    role: profile.user?.role || null,
    location: profile.location || null,
    specialties: profile.specialties || [],
  }
}

// Fiche vue par l'agent. Invitation envoyée à une adresse e-mail déjà inscrite :
// on ne montre pas à qui appartient l'adresse tant que la personne n'a pas accepté.
function managerView(m) {
  const hidden = m.status === 'PENDING' && m.origin === 'INVITED' && !!m.invitedEmail
  return {
    id: m.id,
    status: isExpired(m) ? 'EXPIRED' : m.status,
    origin: m.origin,
    requireApproval: m.requireApproval,
    invitedEmail: m.invitedEmail || null,
    expiresAt: m.expiresAt,
    acceptedAt: m.acceptedAt,
    profile: hidden ? null : summarizeProfile(m.profile),
  }
}

// ── Accès agent ────────────────────────────────────────────
async function requireManager(req, res, next) {
  const me = req.actor || req.user
  try {
    if (!me || !(await hasAgency(me))) {
      return res.status(403).json({ error: 'MANAGEMENT_DISABLED', message: 'La gestion de plusieurs profils demande la formule Agence.' })
    }
  } catch (err) {
    console.error('requireManager:', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
  req.manager = me
  next()
}

// Le titulaire du profil seulement : un agent ne répond jamais à sa place
function requireOwner(req, res, next) {
  if (req.actor) return res.status(403).json({ error: 'MANAGED_FORBIDDEN', message: 'Cette action est réservée au titulaire du compte.' })
  next()
}

async function pendingCount(managerUserId) {
  return prisma.profileManager.count({ where: { managerUserId, status: 'PENDING', expiresAt: { gt: new Date() } } })
}

async function sendInvite({ management, managerName, profileName, to, created }) {
  const token = newInviteToken()
  await prisma.profileManager.update({ where: { id: management.id }, data: { tokenHash: hashToken(token), expiresAt: inviteExpiry() } })
  emails().sendManagedProfileInviteEmail(to, { managerName, profileName, created, token })
    .catch(err => console.error('Invitation gestion (e-mail) :', err.message))
}

// GET /api/managers/profiles
router.get('/profiles', requireAuth, requireManager, async (req, res) => {
  try {
    const list = await prisma.profileManager.findMany({
      where: { managerUserId: req.manager.id, status: { in: ['ACTIVE', 'PENDING'] } },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      include: { profile: { select: PROFILE_SUMMARY } },
    })
    const slots = await agency.profileSlots(req.manager.id)
    // Couleur et messages non lus de chaque profil géré (pastille du sélecteur)
    const active = await managedProfiles(req.manager.id)
    const unread = await unreadByProfile(active)
    const colors = Object.fromEntries(active.map(p => [p.profileId, p.color]))
    res.json({
      profiles: list.map(m => ({ ...managerView(m), color: colors[m.profileId] || null, unread: unread[m.profileId] || 0 })),
      slots: { used: slots.used, included: slots.included, extra: slots.extra, unlimited: slots.unlimited, extraPriceCents: slots.extraPriceCents, interval: slots.interval },
    })
  } catch (err) {
    console.error('GET managers/profiles:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// GET /api/managers/dashboard?month=2026-11 — espace agence (E1)
router.get('/dashboard', requireAuth, requireManager, async (req, res) => {
  try {
    res.set('Cache-Control', 'private, no-store')
    res.json(await agencyDashboard(req.manager.id, { month: req.query.month }))
  } catch (err) {
    console.error('GET managers/dashboard:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// GET /api/managers/agenda?from=…&to=… — agenda de l'agence (B1), 62 jours au plus
router.get('/agenda', requireAuth, requireManager, async (req, res) => {
  try {
    res.set('Cache-Control', 'private, no-store')
    res.json(await agencyAgenda(req.manager.id, { from: req.query.from, to: req.query.to }))
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message })
    console.error('GET managers/agenda:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// GET /api/managers/journal — ce que l'agence a fait pour ses profils (30 dernières actions)
router.get('/journal', requireAuth, requireManager, async (req, res) => {
  try {
    const rows = await journal({ managerUserId: req.manager.id })
    const ids = [...new Set(rows.map(r => r.profileId))]
    const profiles = ids.length ? await prisma.profile.findMany({ where: { id: { in: ids } }, select: PROFILE_SUMMARY }) : []
    const names = Object.fromEntries(profiles.map(p => [p.id, accountName(p.user)]))
    res.json({ entries: rows.map(r => ({ ...r, profileName: names[r.profileId] || null })) })
  } catch (err) {
    console.error('GET managers/journal:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// PATCH /api/managers/profiles/:id/commission { commissionPct } — taux convenu (relevé des cachets)
router.patch('/profiles/:id/commission', requireAuth, requireManager, async (req, res) => {
  const raw = req.body?.commissionPct
  const pct = raw === null || raw === '' ? null : Number(raw)
  if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 50)) return res.status(400).json({ error: 'Le taux doit être compris entre 0 et 50 %.' })
  try {
    const updated = await prisma.profileManager.updateMany({
      where: { id: Number(req.params.id), managerUserId: req.manager.id, status: 'ACTIVE' },
      data: { commissionPct: pct === null ? null : Math.round(pct * 10) / 10 },
    })
    if (!updated.count) return res.status(404).json({ error: 'Profil géré introuvable' })
    res.json({ ok: true, commissionPct: pct === null ? null : Math.round(pct * 10) / 10 })
  } catch (err) {
    console.error('PATCH managers/commission:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// GET /api/managers/candidates?q=nina
router.get('/candidates', requireAuth, requireManager, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 50)
  if (q.length < 2) return res.json({ profiles: [] })
  try {
    const [found, mine] = await Promise.all([
      prisma.profile.findMany({
        where: {
          userId: { not: req.manager.id },
          user: {
            emailVerified: true, pausedAt: null, bannedAt: null, role: { not: 'ADMIN' },
            OR: [
              { pseudo: { contains: q, mode: 'insensitive' } },
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
            ],
          },
        },
        select: PROFILE_SUMMARY,
        take: 8,
      }),
      prisma.profileManager.findMany({ where: { managerUserId: req.manager.id, status: { in: ['ACTIVE', 'PENDING'] } }, select: { profileId: true } }),
    ])
    const taken = new Set(mine.map(m => m.profileId))
    res.json({ profiles: found.map(p => ({ ...summarizeProfile(p), alreadyManaged: taken.has(p.id) })) })
  } catch (err) {
    console.error('GET managers/candidates:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

/** Crée une invitation vers un profil existant (refus si déjà géré par cet agent) */
async function inviteExisting(manager, profile, invitedEmail = null, { acceptExtra = false } = {}) {
  const already = await prisma.profileManager.findFirst({
    where: { managerUserId: manager.id, profileId: profile.id, status: { in: ['ACTIVE', 'PENDING'] } },
  })
  if (already && !isExpired(already)) return { error: 'Vous gérez déjà ce profil ou une invitation est en cours.' }
  if (already) await prisma.profileManager.update({ where: { id: already.id }, data: { status: 'ENDED', endedAt: new Date(), endedBy: 'EXPIRED' } })
  await agency.reserveSlot(manager.id, { acceptExtra })

  const management = await prisma.profileManager.create({
    data: { managerUserId: manager.id, profileId: profile.id, status: 'PENDING', origin: 'INVITED', invitedEmail },
  })
  const managerName = accountName(manager)
  await sendInvite({ management, managerName, profileName: accountName(profile.user), to: profile.user.email, created: false })
  await createNotif({
    userId: profile.user.id,
    type: 'MANAGEMENT_INVITE',
    content: `${managerName} souhaite gérer votre profil. Répondez dans Réglages › Gestion de mon profil.`,
    actorId: manager.id,
  })
  return { management }
}

// POST /api/managers/invite { profileId }
router.post('/invite', requireAuth, requireManager, async (req, res) => {
  const profileId = Number.parseInt(req.body?.profileId, 10)
  if (!Number.isInteger(profileId)) return res.status(400).json({ error: 'Profil invalide' })
  try {
    if (await pendingCount(req.manager.id) >= MAX_PENDING_INVITES) {
      return res.status(429).json({ error: `Vous avez déjà ${MAX_PENDING_INVITES} invitations en attente. Attendez une réponse avant d'en envoyer d'autres.` })
    }
    const profile = await prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true, userId: true, user: { select: { id: true, email: true, pseudo: true, firstName: true, lastName: true, emailVerified: true, bannedAt: true, pausedAt: true } } },
    })
    if (!profile || !profile.user.emailVerified || profile.user.bannedAt || profile.user.pausedAt) return res.status(404).json({ error: 'Profil introuvable' })
    if (profile.userId === req.manager.id) return res.status(400).json({ error: 'C’est votre propre profil.' })
    const result = await inviteExisting(req.manager, profile, null, { acceptExtra: req.body?.acceptExtra === true })
    if (result.error) return res.status(409).json({ error: result.error })
    res.status(201).json({ ok: true })
  } catch (err) {
    if (sendAgencyError(res, err)) return
    console.error('POST managers/invite:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/managers/create { email, pseudo, role, city?, specialties? }
// Le profil reste invisible (compte en pause, e-mail non confirmé) tant que la personne
// ne l'a pas validé avec le lien reçu. Adresse déjà inscrite : on envoie une invitation
// classique, avec la même réponse (on ne révèle pas qui est inscrit).
router.post('/create', requireAuth, requireManager, validate(managedCreateSchema), async (req, res) => {
  const { email, pseudo, role, city, specialties } = req.body
  const sent = { ok: true, message: `Invitation envoyée à ${email}. Le profil restera invisible tant que la personne ne l'a pas validé.` }
  try {
    if (await pendingCount(req.manager.id) >= MAX_PENDING_INVITES) {
      return res.status(429).json({ error: `Vous avez déjà ${MAX_PENDING_INVITES} invitations en attente. Attendez une réponse avant d'en envoyer d'autres.` })
    }

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, pseudo: true, firstName: true, lastName: true, emailVerified: true, bannedAt: true, profile: { select: { id: true, userId: true } } },
    })
    if (existing) {
      if (existing.id === req.manager.id) return res.status(400).json({ error: 'C’est votre propre adresse e-mail.' })
      if (existing.profile && existing.emailVerified && !existing.bannedAt) {
        const result = await inviteExisting(req.manager, { ...existing.profile, user: existing }, email, { acceptExtra: req.body?.acceptExtra === true })
        if (result.error) return res.status(409).json({ error: result.error })
      }
      return res.status(201).json(sent)
    }

    const pseudoTaken = await prisma.user.findUnique({ where: { pseudo }, select: { id: true } })
    if (pseudoTaken) {
      return res.status(409).json({ error: 'Ce nom de profil est déjà pris. Si la personne est déjà inscrite, invitez-la plutôt avec la recherche.' })
    }
    await agency.reserveSlot(req.manager.id, { acceptExtra: req.body?.acceptExtra === true })

    const created = await prisma.user.create({
      data: {
        email,
        pseudo,
        role,
        password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12), // remplacé quand la personne valide
        emailVerified: false,
        pausedAt: new Date(), // invisible tant que non validé
        registrationStep: 3,
        profile: { create: { location: city || null, country: 'France', specialties: specialties || [], ...(role === 'ORGANIZER' && specialties?.length ? { typeEtablissement: specialties[0] } : {}) } },
      },
      select: { id: true, profile: { select: { id: true } } },
    })
    const management = await prisma.profileManager.create({
      data: { managerUserId: req.manager.id, profileId: created.profile.id, status: 'PENDING', origin: 'CREATED', invitedEmail: email },
    })
    const managerName = accountName(req.manager)
    await sendInvite({ management, managerName, profileName: pseudo, to: email, created: true })

    // Nom proche d'un membre déjà inscrit : l'admin vérifie que ce n'est pas un faux profil
    if (pseudo.length >= 4) {
      const similar = await prisma.user.findMany({
        where: { id: { not: created.id }, pseudo: { contains: pseudo, mode: 'insensitive' } },
        select: { pseudo: true }, take: 3,
      })
      if (similar.length) {
        await notifyAdmins({
          type: 'ADMIN_MANAGED_PROFILE_CHECK',
          content: `${managerName} a préparé le profil « ${pseudo} », proche de : ${similar.map(s => s.pseudo).join(', ')}. À vérifier.`,
          actorId: req.manager.id,
        })
      }
    }
    res.status(201).json(sent)
  } catch (err) {
    if (sendAgencyError(res, err)) return
    if (err.code === 'P2002') return res.status(409).json({ error: 'Ce nom de profil ou cette adresse est déjà utilisé.' })
    console.error('POST managers/create:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/managers/profiles/:id/resend
router.post('/profiles/:id/resend', requireAuth, requireManager, async (req, res) => {
  try {
    const management = await prisma.profileManager.findFirst({
      where: { id: Number(req.params.id), managerUserId: req.manager.id, status: 'PENDING' },
      include: { profile: { select: { user: { select: { email: true, pseudo: true, firstName: true, lastName: true } } } } },
    })
    if (!management) return res.status(404).json({ error: 'Invitation introuvable' })
    await sendInvite({
      management,
      managerName: accountName(req.manager),
      profileName: accountName(management.profile.user),
      to: management.invitedEmail || management.profile.user.email,
      created: management.origin === 'CREATED',
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('POST managers/resend:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

/** Profil préparé par l'agent et jamais validé : on le supprime (l'adresse redevient libre) */
async function removeUnclaimedDraft(profileId) {
  const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { id: true, userId: true, user: { select: { emailVerified: true } }, managers: { select: { managerUserId: true } } } })
  if (!profile || profile.user.emailVerified) return
  await prisma.$transaction([
    prisma.profileManager.deleteMany({ where: { profileId } }),
    prisma.profile.delete({ where: { id: profileId } }),
    prisma.user.delete({ where: { id: profile.userId } }),
  ])
  for (const managerUserId of new Set(profile.managers.map(m => m.managerUserId))) await agency.releaseSlots(managerUserId)
}

// DELETE /api/managers/profiles/:id — l'agent arrête de gérer ce profil
router.delete('/profiles/:id', requireAuth, requireManager, async (req, res) => {
  try {
    const management = await prisma.profileManager.findFirst({
      where: { id: Number(req.params.id), managerUserId: req.manager.id, status: { in: ['ACTIVE', 'PENDING'] } },
      include: { profile: { select: { userId: true } } },
    })
    if (!management) return res.status(404).json({ error: 'Profil géré introuvable' })
    if (management.status === 'PENDING' && management.origin === 'CREATED') {
      await removeUnclaimedDraft(management.profileId)
      return res.json({ ok: true })
    }
    await prisma.profileManager.update({ where: { id: management.id }, data: { status: 'ENDED', endedAt: new Date(), endedBy: 'MANAGER', tokenHash: null } })
    await agency.onManagementEnded(management.id)
    if (management.status === 'ACTIVE') {
      await createNotif({
        userId: management.profile.userId,
        type: 'MANAGEMENT_ENDED',
        content: `${accountName(req.manager)} ne gère plus votre profil. Vous gardez tout : profil, avis, agenda et conversations.`,
        actorId: req.manager.id,
      })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('DELETE managers/profiles:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── Côté titulaire du profil ───────────────────────────────

const MANAGER_SUMMARY = { id: true, pseudo: true, firstName: true, lastName: true, role: true, profile: { select: { id: true, avatar: true } } }
const ownerView = (m) => ({
  id: m.id,
  status: isExpired(m) ? 'EXPIRED' : m.status,
  requireApproval: m.requireApproval,
  createdAt: m.createdAt,
  acceptedAt: m.acceptedAt,
  manager: { id: m.manager.id, name: accountName(m.manager), role: m.manager.role, avatar: m.manager.profile?.avatar || null, profileId: m.manager.profile?.id || null },
})

async function myManagement(req, id, status) {
  const profileId = req.user.profile?.id
  if (!profileId) return null
  return prisma.profileManager.findFirst({
    where: { id: Number(id), profileId, ...(status ? { status } : { status: { in: ['ACTIVE', 'PENDING'] } }) },
    include: { manager: { select: MANAGER_SUMMARY } },
  })
}

/** Passe une invitation en gestion active (une seule agence à la fois) */
async function activate(management, requireApproval) {
  const other = await prisma.profileManager.findFirst({ where: { profileId: management.profileId, status: 'ACTIVE', id: { not: management.id } } })
  if (other) return { error: 'Votre profil est déjà géré par une autre agence. Retirez d’abord son accès.' }
  const updated = await prisma.profileManager.update({
    where: { id: management.id },
    data: { status: 'ACTIVE', acceptedAt: new Date(), tokenHash: null, requireApproval: requireApproval !== false },
  })
  await agency.onManagementActive(updated.id)
  return { management: updated }
}

// GET /api/managers/mine
router.get('/mine', requireAuth, requireOwner, async (req, res) => {
  try {
    const profileId = req.user.profile?.id
    if (!profileId) return res.json({ managements: [] })
    const list = await prisma.profileManager.findMany({
      where: { profileId, status: { in: ['ACTIVE', 'PENDING'] } },
      orderBy: { createdAt: 'desc' },
      include: { manager: { select: MANAGER_SUMMARY } },
    })
    res.json({ managements: list.filter(m => !isExpired(m)).map(ownerView) })
  } catch (err) {
    console.error('GET managers/mine:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// GET /api/managers/mine/journal — ce que l'agence a fait pour mon profil
router.get('/mine/journal', requireAuth, requireOwner, async (req, res) => {
  try {
    const profileId = req.user.profile?.id
    if (!profileId) return res.json({ entries: [] })
    const rows = await journal({ profileId })
    const ids = [...new Set(rows.map(r => r.managerUserId))]
    const managers = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, pseudo: true, firstName: true, lastName: true } }) : []
    const names = Object.fromEntries(managers.map(m => [m.id, accountName(m)]))
    res.json({ entries: rows.map(r => ({ ...r, managerName: names[r.managerUserId] || null })) })
  } catch (err) {
    console.error('GET managers/mine/journal:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/managers/mine/:id/accept { requireApproval? }
router.post('/mine/:id/accept', requireAuth, requireOwner, async (req, res) => {
  try {
    const management = await myManagement(req, req.params.id, 'PENDING')
    if (!management || isExpired(management)) return res.status(404).json({ error: 'Invitation introuvable ou expirée' })
    const result = await activate(management, req.body?.requireApproval)
    if (result.error) return res.status(409).json({ error: result.error })
    await createNotif({
      userId: management.managerUserId,
      type: 'MANAGEMENT_ACCEPTED',
      content: `${accountName(req.user)} a accepté que vous gériez son profil.`,
      actorId: req.user.id,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('POST managers/mine/accept:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/managers/mine/:id/decline
router.post('/mine/:id/decline', requireAuth, requireOwner, async (req, res) => {
  try {
    const management = await myManagement(req, req.params.id, 'PENDING')
    if (!management) return res.status(404).json({ error: 'Invitation introuvable' })
    await prisma.profileManager.update({ where: { id: management.id }, data: { status: 'ENDED', endedAt: new Date(), endedBy: 'DECLINED', tokenHash: null } })
    await agency.releaseSlots(management.managerUserId)
    await createNotif({
      userId: management.managerUserId,
      type: 'MANAGEMENT_DECLINED',
      content: `${accountName(req.user)} a refusé votre invitation de gestion.`,
      actorId: req.user.id,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('POST managers/mine/decline:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// PATCH /api/managers/mine/:id { requireApproval }
router.patch('/mine/:id', requireAuth, requireOwner, async (req, res) => {
  if (typeof req.body?.requireApproval !== 'boolean') return res.status(400).json({ error: 'Choix invalide' })
  try {
    const management = await myManagement(req, req.params.id, 'ACTIVE')
    if (!management) return res.status(404).json({ error: 'Gestion introuvable' })
    await prisma.profileManager.update({ where: { id: management.id }, data: { requireApproval: req.body.requireApproval } })
    res.json({ ok: true, requireApproval: req.body.requireApproval })
  } catch (err) {
    console.error('PATCH managers/mine:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// DELETE /api/managers/mine/:id — retirer l'accès (effet immédiat)
router.delete('/mine/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    const management = await myManagement(req, req.params.id)
    if (!management) return res.status(404).json({ error: 'Gestion introuvable' })
    await prisma.profileManager.update({ where: { id: management.id }, data: { status: 'ENDED', endedAt: new Date(), endedBy: 'ARTIST', tokenHash: null } })
    await agency.onManagementEnded(management.id)
    if (management.status === 'ACTIVE') {
      await createNotif({
        userId: management.managerUserId,
        type: 'MANAGEMENT_ENDED',
        content: `${accountName(req.user)} a retiré votre accès de gestion à son profil.`,
        actorId: req.user.id,
      })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('DELETE managers/mine:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── Lien reçu par e-mail ───────────────────────────────────

async function findByToken(token) {
  if (!token || String(token).length > 200) return null
  return prisma.profileManager.findFirst({
    where: { tokenHash: hashToken(token), status: 'PENDING' },
    include: {
      manager: { select: MANAGER_SUMMARY },
      profile: { select: { id: true, userId: true, user: { select: { pseudo: true, firstName: true, lastName: true, role: true } } } },
    },
  })
}

// GET /api/managers/claim/:token
router.get('/claim/:token', optionalAuth, async (req, res) => {
  try {
    const management = await findByToken(req.params.token)
    if (!management || isExpired(management)) return res.status(404).json({ error: 'INVITE_INVALID', message: 'Ce lien n’est plus valable. Demandez à l’agence de vous renvoyer une invitation.' })
    res.json({
      origin: management.origin,
      manager: { name: accountName(management.manager), avatar: management.manager.profile?.avatar || null },
      profile: { name: accountName(management.profile.user), role: management.profile.user.role },
      // Invitation d'un compte existant : il faut être connecté avec ce compte
      signedInAsOwner: !!req.user && !req.actor && req.user.id === management.profile.userId,
    })
  } catch (err) {
    console.error('GET managers/claim:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/managers/claim/:token
router.post('/claim/:token', optionalAuth, async (req, res) => {
  try {
    const management = await findByToken(req.params.token)
    if (!management || isExpired(management)) return res.status(404).json({ error: 'INVITE_INVALID', message: 'Ce lien n’est plus valable. Demandez à l’agence de vous renvoyer une invitation.' })
    const managerName = accountName(management.manager)

    if (management.origin === 'INVITED') {
      if (!req.user || req.actor || req.user.id !== management.profile.userId) {
        return res.status(401).json({ error: 'LOGIN_REQUIRED', message: 'Connectez-vous avec votre compte pour répondre à cette invitation.' })
      }
      const result = await activate(management, req.body?.requireApproval)
      if (result.error) return res.status(409).json({ error: result.error })
    } else {
      // Profil préparé par l'agent : la personne choisit son mot de passe et confirme son identité
      const parsed = managedClaimSchema.safeParse(req.body || {})
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Données invalides' })
      const { password, firstName, lastName, requireApproval } = parsed.data
      const other = await prisma.profileManager.findFirst({ where: { profileId: management.profileId, status: 'ACTIVE' } })
      if (other) return res.status(409).json({ error: 'Ce profil est déjà géré.' })
      await prisma.$transaction([
        prisma.user.update({
          where: { id: management.profile.userId },
          data: { password: await bcrypt.hash(password, 12), firstName, lastName, emailVerified: true, pausedAt: null, passwordChangedAt: new Date() },
        }),
        prisma.profileManager.update({
          where: { id: management.id },
          data: { status: 'ACTIVE', acceptedAt: new Date(), tokenHash: null, requireApproval: requireApproval !== false },
        }),
      ])
      await agency.onManagementActive(management.id)
    }

    await createNotif({
      userId: management.managerUserId,
      type: 'MANAGEMENT_ACCEPTED',
      content: `${accountName(management.profile.user)} a ${management.origin === 'CREATED' ? 'validé son profil' : 'accepté votre invitation'} : vous pouvez maintenant le gérer.`,
    })
    res.json({ ok: true, origin: management.origin, managerName })
  } catch (err) {
    console.error('POST managers/claim:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
module.exports.removeUnclaimedDraft = removeUnclaimedDraft
