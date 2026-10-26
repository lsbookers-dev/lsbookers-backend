// routes/account.js — Réglages du compte (page /settings, 21/10/2026)
//
//   GET    /api/account/settings            tous les réglages du membre
//   PATCH  /api/account/settings            notifications, confidentialité, alertes, actualités
//   PUT    /api/account/password            changer de mot de passe (ferme les autres appareils)
//   POST   /api/account/email               demander un changement d'adresse (e-mail de confirmation)
//   DELETE /api/account/email               annuler la demande en cours
//   POST   /api/account/email/confirm       confirmer la nouvelle adresse (lien reçu par e-mail, sans connexion)
//   GET    /api/account/sessions            appareils connectés
//   DELETE /api/account/sessions/:id        retirer un appareil
//   POST   /api/account/sessions/revoke-others   se déconnecter de tous les autres appareils
//   POST   /api/account/pause | /resume     mettre le compte en pause / le réactiver
//   GET    /api/account/export              télécharger mes données (RGPD)

const express = require('express')
const crypto = require('crypto')
const bcrypt = require('bcrypt')
const rateLimit = require('express-rate-limit')
const { memberOrIp } = require('../lib/rateLimitKeys')
const { z } = require('zod')
const prisma = require('../prisma/client')
const { requireAuth, isAdminUser } = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { issueSession } = require('../lib/sessions')
const { isSameSiteRequest } = require('../lib/session')
const { resolvePrefs, sanitizePrefs } = require('../lib/notifPrefs')

const router = express.Router()
const emails = () => require('../utils/email')
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex')

// Par membre (ou par IP hors connexion), cf. lib/rateLimitKeys
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: memberOrIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez dans quelques minutes' },
})

const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: memberOrIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de téléchargements, réessayez dans une heure' },
})

// ── Schémas ────────────────────────────────────────────────
const settingsSchema = z.object({
  notifPrefs:       z.record(z.object({ bell: z.boolean().optional(), email: z.boolean().optional() })).optional(),
  weeklyRecap:      z.boolean().optional(),
  newsletterOptIn:  z.boolean().optional(),
  loginAlerts:      z.boolean().optional(),
  messagePolicy:    z.enum(['EVERYONE', 'FOLLOWED']).optional(),
  hiddenFromSearch: z.boolean().optional(),
})

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Mot de passe actuel requis').max(200),
  newPassword:     z.string().min(8, 'Le nouveau mot de passe doit contenir au moins 8 caractères').max(200),
})

const emailChangeSchema = z.object({
  newEmail: z.string().email('Adresse e-mail invalide').max(200).toLowerCase().trim(),
  password: z.string().min(1, 'Mot de passe requis').max(200),
})

const tokenSchema = z.object({ token: z.string().min(20).max(200) })

// ── Réglages ───────────────────────────────────────────────
async function readSettings(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true, pendingEmail: true, pendingEmailExpiresAt: true, createdAt: true, passwordChangedAt: true,
      notifPrefs: true, newsletterOptIn: true, loginAlerts: true, pausedAt: true, role: true,
      profile: { select: { weeklyRecap: true, messagePolicy: true, hiddenFromSearch: true } },
    },
  })
  if (!user) return null
  const pendingValid = user.pendingEmail && user.pendingEmailExpiresAt && user.pendingEmailExpiresAt > new Date()
  return {
    email: user.email,
    pendingEmail: pendingValid ? user.pendingEmail : null,
    createdAt: user.createdAt,
    passwordChangedAt: user.passwordChangedAt,
    notifPrefs: resolvePrefs(user.notifPrefs),
    weeklyRecap: !!user.profile?.weeklyRecap,
    newsletterOptIn: user.newsletterOptIn,
    loginAlerts: user.loginAlerts,
    messagePolicy: user.profile?.messagePolicy || 'EVERYONE',
    hiddenFromSearch: !!user.profile?.hiddenFromSearch,
    pausedAt: user.pausedAt,
    role: user.role,
  }
}

router.get('/settings', requireAuth, async (req, res) => {
  try {
    const settings = await readSettings(req.user.id)
    if (!settings) return res.status(404).json({ error: 'Compte introuvable' })
    res.json({ settings })
  } catch (err) {
    console.error('❌ GET /account/settings', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

router.patch('/settings', requireAuth, validate(settingsSchema), async (req, res) => {
  try {
    const { notifPrefs, weeklyRecap, newsletterOptIn, loginAlerts, messagePolicy, hiddenFromSearch } = req.body
    const userData = {}
    if (notifPrefs !== undefined) {
      const current = await prisma.user.findUnique({ where: { id: req.user.id }, select: { notifPrefs: true } })
      const merged = { ...(current?.notifPrefs || {}) }
      for (const [key, value] of Object.entries(sanitizePrefs(notifPrefs))) merged[key] = { ...(merged[key] || {}), ...value }
      userData.notifPrefs = merged
    }
    if (newsletterOptIn !== undefined) {
      userData.newsletterOptIn = newsletterOptIn
      userData.newsletterOptInAt = newsletterOptIn ? new Date() : null
    }
    if (loginAlerts !== undefined) userData.loginAlerts = loginAlerts

    const profileData = {}
    if (weeklyRecap !== undefined) profileData.weeklyRecap = weeklyRecap
    if (messagePolicy !== undefined) profileData.messagePolicy = messagePolicy
    if (hiddenFromSearch !== undefined) profileData.hiddenFromSearch = hiddenFromSearch

    if (Object.keys(userData).length) await prisma.user.update({ where: { id: req.user.id }, data: userData })
    if (Object.keys(profileData).length) await prisma.profile.updateMany({ where: { userId: req.user.id }, data: profileData })

    res.json({ settings: await readSettings(req.user.id) })
  } catch (err) {
    console.error('❌ PATCH /account/settings', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── Mot de passe ───────────────────────────────────────────
router.put('/password', sensitiveLimiter, requireAuth, validate(passwordSchema), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    if (!user) return res.status(404).json({ error: 'Compte introuvable' })
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' })
    }
    if (await bcrypt.compare(newPassword, user.password)) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit être différent de l’actuel' })
    }

    // Nouveau mot de passe + fin de toutes les autres sessions (anciens jetons compris)
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { password: await bcrypt.hash(newPassword, 10), passwordChangedAt: new Date(), tokenVersion: { increment: 1 } },
    })
    await prisma.userSession.updateMany({
      where: { userId: user.id, revokedAt: null, ...(req.sessionSid ? { sid: { not: req.sessionSid } } : {}) },
      data: { revokedAt: new Date() },
    })
    // Cet appareil reste connecté (nouveau jeton, même session)
    const { token } = await issueSession(req, res, updated, req.sessionSid ? { sid: req.sessionSid } : {})
    res.json({ ok: true, ...(isSameSiteRequest(req) ? {} : { token }) })
  } catch (err) {
    console.error('❌ PUT /account/password', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── Adresse e-mail ─────────────────────────────────────────
router.post('/email', sensitiveLimiter, requireAuth, validate(emailChangeSchema), async (req, res) => {
  try {
    const { newEmail, password } = req.body
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, email: true, password: true } })
    if (!user) return res.status(404).json({ error: 'Compte introuvable' })
    if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Mot de passe incorrect' })
    if (newEmail === user.email) return res.status(400).json({ error: 'C’est déjà votre adresse actuelle' })
    const taken = await prisma.user.findUnique({ where: { email: newEmail }, select: { id: true } })
    if (taken) return res.status(409).json({ error: 'Cette adresse est déjà utilisée par un autre compte' })

    const token = crypto.randomBytes(32).toString('hex')
    await prisma.user.update({
      where: { id: user.id },
      data: { pendingEmail: newEmail, pendingEmailTokenHash: sha256(token), pendingEmailExpiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
    })
    await emails().sendEmailChangeConfirmation(newEmail, token)
    res.json({ ok: true, pendingEmail: newEmail })
  } catch (err) {
    console.error('❌ POST /account/email', err)
    res.status(500).json({ error: 'Impossible d’envoyer l’e-mail de confirmation' })
  }
})

router.delete('/email', requireAuth, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null },
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('❌ DELETE /account/email', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

router.post('/email/confirm', sensitiveLimiter, validate(tokenSchema), async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { pendingEmailTokenHash: sha256(req.body.token) },
      select: { id: true, email: true, pendingEmail: true, pendingEmailExpiresAt: true },
    })
    if (!user || !user.pendingEmail || !user.pendingEmailExpiresAt || user.pendingEmailExpiresAt < new Date()) {
      return res.status(400).json({ error: 'Lien invalide ou expiré. Refaites la demande depuis vos Réglages.' })
    }
    const taken = await prisma.user.findUnique({ where: { email: user.pendingEmail }, select: { id: true } })
    if (taken && taken.id !== user.id) return res.status(409).json({ error: 'Cette adresse est déjà utilisée par un autre compte' })

    const oldEmail = user.email
    await prisma.user.update({
      where: { id: user.id },
      data: { email: user.pendingEmail, emailVerified: true, pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null },
    })
    emails().sendEmailChangedNotice(oldEmail, user.pendingEmail).catch(err => console.error('❌ avis changement e-mail :', err.message))
    res.json({ ok: true, email: user.pendingEmail })
  } catch (err) {
    console.error('❌ POST /account/email/confirm', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── Appareils connectés ────────────────────────────────────
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = await prisma.userSession.findMany({
      where: { userId: req.user.id, revokedAt: null, lastUsedAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, sid: true, name: true, createdAt: true, lastUsedAt: true },
    })
    res.json({
      sessions: sessions.map(({ sid, ...s }) => ({ ...s, current: sid === req.sessionSid })),
      // Connexion ouverte avant la mise en place de la liste des appareils
      legacyCurrent: !req.sessionSid,
    })
  } catch (err) {
    console.error('❌ GET /account/sessions', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

router.delete('/sessions/:id', requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10)
  if (!id) return res.status(400).json({ error: 'ID invalide' })
  try {
    const session = await prisma.userSession.findFirst({ where: { id, userId: req.user.id }, select: { id: true, sid: true } })
    if (!session) return res.status(404).json({ error: 'Appareil introuvable' })
    if (session.sid === req.sessionSid) return res.status(400).json({ error: 'Pour cet appareil, utilisez « Se déconnecter »' })
    await prisma.userSession.update({ where: { id }, data: { revokedAt: new Date() } })
    res.json({ ok: true })
  } catch (err) {
    console.error('❌ DELETE /account/sessions/:id', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

router.post('/sessions/revoke-others', sensitiveLimiter, requireAuth, async (req, res) => {
  try {
    await prisma.userSession.updateMany({
      where: { userId: req.user.id, revokedAt: null, ...(req.sessionSid ? { sid: { not: req.sessionSid } } : {}) },
      data: { revokedAt: new Date() },
    })
    // Les anciens jetons (sans appareil) sont fermés aussi ; cet appareil reçoit un nouveau jeton
    const updated = await prisma.user.update({ where: { id: req.user.id }, data: { tokenVersion: { increment: 1 } } })
    const { token } = await issueSession(req, res, updated, req.sessionSid ? { sid: req.sessionSid } : {})
    res.json({ ok: true, ...(isSameSiteRequest(req) ? {} : { token }) })
  } catch (err) {
    console.error('❌ POST /account/sessions/revoke-others', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── Pause du compte ────────────────────────────────────────
router.post('/pause', requireAuth, async (req, res) => {
  if (isAdminUser(req.user)) return res.status(403).json({ error: 'Un compte admin ne peut pas être mis en pause' })
  try {
    await prisma.user.update({ where: { id: req.user.id }, data: { pausedAt: new Date() } })
    res.json({ settings: await readSettings(req.user.id) })
  } catch (err) {
    console.error('❌ POST /account/pause', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

router.post('/resume', requireAuth, async (req, res) => {
  try {
    await prisma.user.update({ where: { id: req.user.id }, data: { pausedAt: null } })
    res.json({ settings: await readSettings(req.user.id) })
  } catch (err) {
    console.error('❌ POST /account/resume', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── Mes données (RGPD) ─────────────────────────────────────
router.get('/export', exportLimiter, requireAuth, async (req, res) => {
  try {
    const userId = req.user.id
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, role: true, createdAt: true, pseudo: true, firstName: true, lastName: true,
        dateOfBirth: true, phone: true, countryOfResidence: true, newsletterOptIn: true, newsletterOptInAt: true,
        notifPrefs: true, loginAlerts: true, pausedAt: true,
        profile: true,
      },
    })
    if (!user) return res.status(404).json({ error: 'Compte introuvable' })
    const profileId = user.profile?.id ?? -1

    const [
      publications, comments, likesGiven, following, followers, blocked, messages,
      bookingsSent, bookingsReceived, reviewsGiven, reviewsReceived, offers, applications,
      events, availability, albums, notifications, sessions,
    ] = await Promise.all([
      prisma.publication.findMany({ where: { profileId }, include: { additionalMedia: true } }),
      prisma.publicationComment.findMany({ where: { profileId }, select: { id: true, publicationId: true, content: true, createdAt: true } }),
      prisma.publicationLike.findMany({ where: { profileId }, select: { publicationId: true, createdAt: true } }),
      prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true, createdAt: true } }),
      prisma.follow.findMany({ where: { followingId: userId }, select: { followerId: true, createdAt: true } }),
      prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true, createdAt: true } }),
      prisma.message.findMany({ where: { senderId: userId }, select: { id: true, conversationId: true, content: true, attachmentUrl: true, type: true, createdAt: true } }),
      prisma.bookingRequest.findMany({ where: { requesterId: profileId } }),
      prisma.bookingRequest.findMany({ where: { targetId: profileId } }),
      prisma.review.findMany({ where: { authorId: profileId } }),
      prisma.review.findMany({ where: { targetId: profileId } }),
      prisma.offer.findMany({ where: { organizerId: profileId } }),
      prisma.application.findMany({ where: { applicantId: profileId } }),
      prisma.event.findMany({ where: { profileId } }),
      prisma.availability.findMany({ where: { profileId } }),
      prisma.album.findMany({ where: { profileId }, include: { items: true } }),
      prisma.notification.findMany({ where: { userId }, select: { type: true, content: true, read: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 500 }),
      prisma.userSession.findMany({ where: { userId }, select: { name: true, createdAt: true, lastUsedAt: true, revokedAt: true } }),
    ])

    const data = {
      exportedAt: new Date().toISOString(),
      notice: 'Données de votre compte LS Bookers (droit d’accès et de portabilité, RGPD). Les messages reçus appartiennent aussi à leurs auteurs : seuls les messages que vous avez envoyés figurent ici.',
      account: user,
      publications, comments, likesGiven, following, followers, blocked, messagesSent: messages,
      bookings: { sent: bookingsSent, received: bookingsReceived },
      reviews: { given: reviewsGiven, received: reviewsReceived },
      offers, applications, events, availability, albums, notifications, devices: sessions,
    }
    const date = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="lsbookers-mes-donnees-${date}.json"`)
    res.send(JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('❌ GET /account/export', err)
    res.status(500).json({ error: 'Impossible de préparer vos données' })
  }
})

module.exports = router
