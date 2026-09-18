// routes/bookingDetail.js — Détail d'un booking (logistique, médias, notes partagées)
const express  = require('express')
const router   = express.Router()
const prisma   = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { uploadBufferToR2 } = require('../lib/r2')
const multer   = require('multer')
const upload   = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

// ─── Helper : vérifie que l'utilisateur est organisateur ou cible du booking ──
async function canAccessBooking(userId, bookingId) {
  const booking = await prisma.bookingRequest.findUnique({
    where: { id: bookingId },
    include: {
      requester: { include: { user: true } },
      target:    { include: { user: true } },
    },
  })
  if (!booking) return null
  const isRequester = booking.requester.user.id === userId
  const isTarget    = booking.target.user.id    === userId
  if (!isRequester && !isTarget) return null
  return { booking, isOrganizer: isRequester }
}

// ─── GET /:id — détail complet du booking ─────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  const result = await canAccessBooking(req.user.id, id)
  if (!result) return res.status(403).json({ error: 'Accès refusé' })

  try {
    const booking = await prisma.bookingRequest.findUnique({
      where: { id },
      include: {
        requester: { include: { user: { select: { id: true, pseudo: true, firstName: true, lastName: true, avatar: true } } } },
        target:    { include: { user: { select: { id: true, pseudo: true, firstName: true, lastName: true, avatar: true } } } },
        logistics: { orderBy: { createdAt: 'desc' } },
        media:     { orderBy: { createdAt: 'desc' } },
      },
    })
    res.json({ booking })
  } catch (err) {
    console.error('❌ bookingDetail GET /:id', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── PATCH /:id/notes — mettre à jour les notes partagées ────────────────────
router.patch('/:id/notes', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  const result = await canAccessBooking(req.user.id, id)
  if (!result) return res.status(403).json({ error: 'Accès refusé' })

  const { sharedNotes } = req.body
  try {
    const updated = await prisma.bookingRequest.update({
      where: { id },
      data:  { sharedNotes: sharedNotes ?? null },
    })
    res.json({ sharedNotes: updated.sharedNotes })
  } catch (err) {
    console.error('❌ bookingDetail PATCH /:id/notes', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── POST /:id/logistics — ajouter un élément logistique ─────────────────────
router.post('/:id/logistics', requireAuth, upload.single('file'), async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  const result = await canAccessBooking(req.user.id, id)
  if (!result || !result.isOrganizer) return res.status(403).json({ error: 'Seul l\'organisateur peut ajouter un élément logistique' })

  const { type, title } = req.body
  if (!type || !title?.trim()) return res.status(400).json({ error: 'Type et titre requis' })
  if (!['HOTEL', 'TRANSPORT'].includes(type)) return res.status(400).json({ error: 'Type invalide' })

  try {
    let fileUrl  = null
    let fileName = null

    if (req.file) {
      const ext = req.file.originalname.split('.').pop()
      const key = `logistics/${id}/${Date.now()}.${ext}`
      fileUrl  = await uploadBufferToR2(req.file.buffer, key, req.file.mimetype)
      fileName = req.file.originalname
    }

    const logistic = await prisma.bookingLogistic.create({
      data: { bookingRequestId: id, type, title: title.trim(), fileUrl, fileName },
    })
    res.status(201).json({ logistic })
  } catch (err) {
    console.error('❌ bookingDetail POST /:id/logistics', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── DELETE /:id/logistics/:logId ────────────────────────────────────────────
router.delete('/:id/logistics/:logId', requireAuth, async (req, res) => {
  const id    = parseInt(req.params.id,    10)
  const logId = parseInt(req.params.logId, 10)
  if (isNaN(id) || isNaN(logId)) return res.status(400).json({ error: 'ID invalide' })

  const result = await canAccessBooking(req.user.id, id)
  if (!result || !result.isOrganizer) return res.status(403).json({ error: 'Accès refusé' })

  try {
    await prisma.bookingLogistic.delete({ where: { id: logId } })
    res.json({ ok: true })
  } catch (err) {
    console.error('❌ bookingDetail DELETE /:id/logistics/:logId', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── POST /:id/media — upload un média promo ─────────────────────────────────
router.post('/:id/media', requireAuth, upload.single('file'), async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  const result = await canAccessBooking(req.user.id, id)
  if (!result || !result.isOrganizer) return res.status(403).json({ error: 'Seul l\'organisateur peut ajouter un média' })

  if (!req.file) return res.status(400).json({ error: 'Fichier requis' })

  try {
    const ext       = req.file.originalname.split('.').pop()
    const key       = `booking-media/${id}/${Date.now()}.${ext}`
    const url       = await uploadBufferToR2(req.file.buffer, key, req.file.mimetype)
    const mediaType = req.file.mimetype.startsWith('video') ? 'VIDEO' : 'IMAGE'
    const name      = req.file.originalname

    const media = await prisma.bookingMedia.create({
      data: { bookingRequestId: id, url, mediaType, name },
    })
    res.status(201).json({ media })
  } catch (err) {
    console.error('❌ bookingDetail POST /:id/media', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── DELETE /:id/media/:mediaId ───────────────────────────────────────────────
router.delete('/:id/media/:mediaId', requireAuth, async (req, res) => {
  const id      = parseInt(req.params.id,      10)
  const mediaId = parseInt(req.params.mediaId, 10)
  if (isNaN(id) || isNaN(mediaId)) return res.status(400).json({ error: 'ID invalide' })

  const result = await canAccessBooking(req.user.id, id)
  if (!result || !result.isOrganizer) return res.status(403).json({ error: 'Accès refusé' })

  try {
    await prisma.bookingMedia.delete({ where: { id: mediaId } })
    res.json({ ok: true })
  } catch (err) {
    console.error('❌ bookingDetail DELETE /:id/media/:mediaId', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
