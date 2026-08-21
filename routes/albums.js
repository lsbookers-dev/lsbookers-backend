const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')

// ── Helpers ──────────────────────────────────────────────────
async function getProfileOfUser(userId) {
  return prisma.profile.findUnique({ where: { userId } })
}

// ── GET /api/albums/profile/:profileId ───────────────────────
// Récupère tous les albums publics d'un profil (+ les siens si connecté)
router.get('/profile/:profileId', async (req, res) => {
  const profileId = parseInt(req.params.profileId, 10)
  if (isNaN(profileId)) return res.status(400).json({ error: 'profileId invalide' })

  try {
    const albums = await prisma.album.findMany({
      where: {
        profileId,
        isPrivate: false,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { items: true } },
        items: {
          orderBy: { order: 'asc' },
          take: 1,
          select: {
            id: true,
            mediaUrl: true,
            mediaType: true,
            publication: { select: { media: true, mediaType: true } },
          },
        },
      },
    })

    // Calculer la coverUrl pour chaque album (custom ou auto depuis 1er item)
    const result = albums.map(a => ({
      id:          a.id,
      title:       a.title,
      description: a.description,
      coverUrl:    a.coverUrl || a.items[0]?.mediaUrl || a.items[0]?.publication?.media || null,
      coverType:   a.items[0]?.mediaType || a.items[0]?.publication?.mediaType || 'image',
      itemCount:   a._count.items,
      createdAt:   a.createdAt,
    }))

    return res.json({ albums: result })
  } catch (err) {
    console.error('❌ GET /albums/profile/:profileId :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── GET /api/albums/mine ─────────────────────────────────────
// Récupère tous les albums de l'utilisateur connecté (public + privé)
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const profile = await getProfileOfUser(req.user.id)
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })

    const albums = await prisma.album.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { items: true } },
        items: {
          orderBy: { order: 'asc' },
          take: 1,
          select: {
            id: true,
            mediaUrl: true,
            mediaType: true,
            publication: { select: { media: true, mediaType: true } },
          },
        },
      },
    })

    const result = albums.map(a => ({
      id:          a.id,
      title:       a.title,
      description: a.description,
      isPrivate:   a.isPrivate,
      coverUrl:    a.coverUrl || a.items[0]?.mediaUrl || a.items[0]?.publication?.media || null,
      coverType:   a.items[0]?.mediaType || a.items[0]?.publication?.mediaType || 'image',
      itemCount:   a._count.items,
      createdAt:   a.createdAt,
    }))

    return res.json({ albums: result })
  } catch (err) {
    console.error('❌ GET /albums/mine :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── GET /api/albums/:id ──────────────────────────────────────
// Récupère un album avec tous ses items
router.get('/:id(\\d+)', async (req, res) => {
  const id = parseInt(req.params.id, 10)
  try {
    const album = await prisma.album.findUnique({
      where: { id },
      include: {
        profile: {
          select: {
            id: true,
            avatar: true,
            user: { select: { pseudo: true, firstName: true, lastName: true } },
          },
        },
        items: {
          orderBy: { order: 'asc' },
          include: {
            publication: {
              select: {
                id: true, title: true, media: true, mediaType: true, caption: true,
                additionalMedia: { orderBy: { order: 'asc' }, select: { url: true, mediaType: true } },
                _count: { select: { likes: true, comments: true } },
              },
            },
          },
        },
      },
    })

    if (!album) return res.status(404).json({ error: 'Album introuvable' })
    if (album.isPrivate) return res.status(403).json({ error: 'Album privé' })

    return res.json({ album })
  } catch (err) {
    console.error('❌ GET /albums/:id :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── POST /api/albums ─────────────────────────────────────────
// Créer un album
router.post('/', requireAuth, async (req, res) => {
  const { title, description, isPrivate } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Titre requis' })

  try {
    const profile = await getProfileOfUser(req.user.id)
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })

    const album = await prisma.album.create({
      data: {
        profileId:   profile.id,
        title:       String(title).trim().slice(0, 100),
        description: description ? String(description).trim().slice(0, 500) : null,
        isPrivate:   !!isPrivate,
      },
    })

    return res.status(201).json({ album })
  } catch (err) {
    console.error('❌ POST /albums :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── PUT /api/albums/:id ──────────────────────────────────────
// Modifier un album (titre, description, coverUrl, isPrivate)
router.put('/:id(\\d+)', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  const { title, description, coverUrl, isPrivate } = req.body

  try {
    const profile = await getProfileOfUser(req.user.id)
    const album   = await prisma.album.findUnique({ where: { id } })

    if (!album) return res.status(404).json({ error: 'Album introuvable' })
    if (!profile || album.profileId !== profile.id) return res.status(403).json({ error: 'Accès interdit' })

    const updated = await prisma.album.update({
      where: { id },
      data: {
        ...(title       !== undefined && { title:       String(title).trim().slice(0, 100) }),
        ...(description !== undefined && { description: description ? String(description).trim().slice(0, 500) : null }),
        ...(coverUrl    !== undefined && { coverUrl:    coverUrl || null }),
        ...(isPrivate   !== undefined && { isPrivate:   !!isPrivate }),
      },
    })

    return res.json({ album: updated })
  } catch (err) {
    console.error('❌ PUT /albums/:id :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── DELETE /api/albums/:id ───────────────────────────────────
router.delete('/:id(\\d+)', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  try {
    const profile = await getProfileOfUser(req.user.id)
    const album   = await prisma.album.findUnique({ where: { id } })

    if (!album) return res.status(404).json({ error: 'Album introuvable' })
    if (!profile || album.profileId !== profile.id) return res.status(403).json({ error: 'Accès interdit' })

    await prisma.album.delete({ where: { id } })
    return res.json({ ok: true })
  } catch (err) {
    console.error('❌ DELETE /albums/:id :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── POST /api/albums/:id/items ───────────────────────────────
// Ajouter un item à un album (publication existante OU média direct)
router.post('/:id(\\d+)/items', requireAuth, async (req, res) => {
  const albumId = parseInt(req.params.id, 10)
  const { publicationId, mediaUrl, mediaType, caption } = req.body

  if (!publicationId && !mediaUrl) {
    return res.status(400).json({ error: 'publicationId ou mediaUrl requis' })
  }

  try {
    const profile = await getProfileOfUser(req.user.id)
    const album   = await prisma.album.findUnique({ where: { id: albumId } })

    if (!album) return res.status(404).json({ error: 'Album introuvable' })
    if (!profile || album.profileId !== profile.id) return res.status(403).json({ error: 'Accès interdit' })

    // Trouver l'ordre max actuel
    const last = await prisma.albumItem.findFirst({
      where: { albumId },
      orderBy: { order: 'desc' },
      select: { order: true },
    })

    const item = await prisma.albumItem.create({
      data: {
        albumId,
        publicationId: publicationId ? parseInt(publicationId, 10) : null,
        mediaUrl:      mediaUrl   || null,
        mediaType:     mediaType  || 'image',
        caption:       caption    ? String(caption).trim().slice(0, 300) : null,
        order:         (last?.order ?? -1) + 1,
      },
      include: {
        publication: {
          select: { id: true, title: true, media: true, mediaType: true },
        },
      },
    })

    // Mettre à jour updatedAt de l'album
    await prisma.album.update({ where: { id: albumId }, data: { updatedAt: new Date() } })

    return res.status(201).json({ item })
  } catch (err) {
    console.error('❌ POST /albums/:id/items :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── DELETE /api/albums/:id/items/:itemId ─────────────────────
router.delete('/:id(\\d+)/items/:itemId(\\d+)', requireAuth, async (req, res) => {
  const albumId = parseInt(req.params.id, 10)
  const itemId  = parseInt(req.params.itemId, 10)

  try {
    const profile = await getProfileOfUser(req.user.id)
    const album   = await prisma.album.findUnique({ where: { id: albumId } })

    if (!album) return res.status(404).json({ error: 'Album introuvable' })
    if (!profile || album.profileId !== profile.id) return res.status(403).json({ error: 'Accès interdit' })

    await prisma.albumItem.deleteMany({ where: { id: itemId, albumId } })
    return res.json({ ok: true })
  } catch (err) {
    console.error('❌ DELETE /albums/:id/items/:itemId :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
