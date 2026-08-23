// routes/adminPosts.js
const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth, requireAdmin } = require('../middleware/auth')

// ─── GET / — liste toutes les publications admin ────────────────────────────
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const posts = await prisma.adminPost.findMany({
      orderBy: { createdAt: 'desc' },
    })
    res.json({ posts })
  } catch (err) {
    console.error('❌ AdminPosts GET /', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── POST / — créer une publication ────────────────────────────────────────
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { title, content, mediaUrl, mediaType } = req.body

  if (!content && !mediaUrl) {
    return res.status(400).json({ error: 'Au moins un contenu ou un média est requis.' })
  }

  try {
    const post = await prisma.adminPost.create({
      data: {
        title:     title     || null,
        content:   content   || null,
        mediaUrl:  mediaUrl  || null,
        mediaType: mediaType || null,
        active:    true,
      },
    })
    res.status(201).json({ post })
  } catch (err) {
    console.error('❌ AdminPosts POST /', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── DELETE /:id — supprimer une publication ────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  try {
    await prisma.adminPost.delete({ where: { id } })
    res.json({ ok: true })
  } catch (err) {
    console.error('❌ AdminPosts DELETE /:id', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── PATCH /:id/toggle — basculer le statut actif ──────────────────────────
router.patch('/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  try {
    const current = await prisma.adminPost.findUnique({ where: { id } })
    if (!current) return res.status(404).json({ error: 'Publication introuvable' })

    const updated = await prisma.adminPost.update({
      where: { id },
      data:  { active: !current.active },
    })
    res.json({ post: updated })
  } catch (err) {
    console.error('❌ AdminPosts PATCH /:id/toggle', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
