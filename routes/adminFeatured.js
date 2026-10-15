// routes/adminFeatured.js — carrousel de l'accueil, géré à la main par l'admin
// (à terme : l'admin y ajoute les profils qui ont payé leur mise en avant)
const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth, requireAdmin } = require('../middleware/auth')

const MEMBER_ROLES = ['ARTIST', 'ORGANIZER', 'PROVIDER']

const parseDate = (value) => {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

const format = (f) => ({
  id: f.id,
  position: f.position,
  endsAt: f.endsAt,
  note: f.note,
  createdAt: f.createdAt,
  active: !f.endsAt || f.endsAt > new Date(),
  user: {
    id: f.profile.user.id,
    name: f.profile.user.pseudo || [f.profile.user.firstName, f.profile.user.lastName].filter(Boolean).join(' ') || 'Utilisateur',
    email: f.profile.user.email,
    role: f.profile.user.role,
    avatar: f.profile.avatar || null,
  },
})

const INCLUDE = { profile: { include: { user: { select: { id: true, pseudo: true, firstName: true, lastName: true, email: true, role: true } } } } }

// GET /api/admin/featured — profils du carrousel (y compris ceux dont la mise en avant est finie)
router.get('/', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const rows = await prisma.homeFeatured.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: INCLUDE })
    res.json({ featured: rows.map(format) })
  } catch (err) {
    console.error('❌ AdminFeatured GET /', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/admin/featured { userId, endsAt?, note? } — ajouter un profil à la fin du carrousel
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number.parseInt(req.body?.userId, 10)
  if (!userId) return res.status(400).json({ error: 'Utilisateur manquant' })
  const endsAt = parseDate(req.body?.endsAt)
  try {
    const profile = await prisma.profile.findUnique({ where: { userId }, include: { user: { select: { role: true } } } })
    if (!profile || !MEMBER_ROLES.includes(profile.user.role)) return res.status(404).json({ error: 'Profil introuvable' })
    const exists = await prisma.homeFeatured.findUnique({ where: { profileId: profile.id } })
    if (exists) return res.status(409).json({ error: 'Ce profil est déjà dans le carrousel' })
    const last = await prisma.homeFeatured.findFirst({ orderBy: { position: 'desc' }, select: { position: true } })
    const row = await prisma.homeFeatured.create({
      data: {
        profileId: profile.id,
        position: (last?.position ?? -1) + 1,
        endsAt: endsAt ?? null,
        note: req.body?.note ? String(req.body.note).slice(0, 300) : null,
      },
      include: INCLUDE,
    })
    res.status(201).json({ featured: format(row) })
  } catch (err) {
    console.error('❌ AdminFeatured POST /', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// PUT /api/admin/featured/order { ids: [...] } — nouvel ordre d'affichage
router.put('/order', requireAuth, requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : []
  if (!ids.length) return res.status(400).json({ error: 'Ordre manquant' })
  try {
    await prisma.$transaction(ids.map((id, position) => prisma.homeFeatured.update({ where: { id }, data: { position } })))
    res.json({ ok: true })
  } catch (err) {
    console.error('❌ AdminFeatured PUT /order', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// PATCH /api/admin/featured/:id { endsAt?, note? }
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10)
  if (!id) return res.status(400).json({ error: 'ID invalide' })
  const data = {}
  const endsAt = parseDate(req.body?.endsAt)
  if (endsAt !== undefined) data.endsAt = endsAt
  if (req.body?.note !== undefined) data.note = req.body.note ? String(req.body.note).slice(0, 300) : null
  try {
    const row = await prisma.homeFeatured.update({ where: { id }, data, include: INCLUDE })
    res.json({ featured: format(row) })
  } catch (err) {
    console.error('❌ AdminFeatured PATCH /:id', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// DELETE /api/admin/featured/:id — retirer du carrousel
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10)
  if (!id) return res.status(400).json({ error: 'ID invalide' })
  try {
    await prisma.homeFeatured.delete({ where: { id } })
    res.json({ ok: true })
  } catch (err) {
    console.error('❌ AdminFeatured DELETE /:id', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
