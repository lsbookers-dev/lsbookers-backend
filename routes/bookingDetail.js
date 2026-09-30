// routes/bookingDetail.js — Détail d'un booking (logistique, médias, notes partagées)
const express  = require('express')
const router   = express.Router()
const prisma   = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { uploadBufferToR2 } = require('../lib/r2')
const { isFileContentValid, extensionFor } = require('../lib/fileCheck')
const multer   = require('multer')

// Types acceptés : logistique = billets / réservations (PDF ou photo), médias promo = images / vidéos
const LOGISTIC_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
const MEDIA_MIME    = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'])

function makeUpload(allowed) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => allowed.has(file.mimetype)
      ? cb(null, true)
      : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'FORMAT_NOT_ALLOWED')),
  })
}

// Middleware multer avec erreurs JSON propres (format refusé / trop gros)
function singleFile(allowed) {
  const upload = makeUpload(allowed).single('file')
  return (req, res, next) => upload(req, res, (err) => {
    if (!err) return next()
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'FILE_TOO_LARGE', max: '50MB' })
    if (err instanceof multer.MulterError) return res.status(400).json({ error: 'FORMAT_NOT_ALLOWED' })
    return res.status(400).json({ error: 'UPLOAD_ERROR' })
  })
}

// ─── Helper : vérifie que l'utilisateur est organisateur ou cible du booking ──
async function canAccessBooking(userId, bookingId) {
  try {
    const booking = await prisma.bookingRequest.findUnique({
      where: { id: bookingId },
      include: {
        requester: { select: { user: { select: { id: true } } } },
        target:    { select: { user: { select: { id: true } } } },
      },
    })
    if (!booking) return null
    if (!booking.requester?.user || !booking.target?.user) return null
    const isRequester = booking.requester.user.id === userId
    const isTarget    = booking.target.user.id    === userId
    if (!isRequester && !isTarget) return null
    return { booking, isOrganizer: isRequester }
  } catch (err) {
    console.error('❌ canAccessBooking error:', err)
    return null
  }
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
        requester: {
          include: {
            user: { select: { id: true, pseudo: true, firstName: true, lastName: true } },
          },
        },
        target: {
          include: {
            user: { select: { id: true, pseudo: true, firstName: true, lastName: true } },
          },
        },
      },
    })

    // Requêtes SQL brutes — évite toute dépendance à la version du client Prisma généré
    const logistics = await prisma.$queryRaw`
      SELECT id, "bookingRequestId", type::text, title, "fileUrl", "fileName", "createdAt"
      FROM "BookingLogistic"
      WHERE "bookingRequestId" = ${id}
      ORDER BY "createdAt" DESC
    `
    const media = await prisma.$queryRaw`
      SELECT id, "bookingRequestId", url, "mediaType", name, "createdAt"
      FROM "BookingMedia"
      WHERE "bookingRequestId" = ${id}
      ORDER BY "createdAt" DESC
    `

    res.json({ booking: { ...booking, logistics, media } })
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
router.post('/:id/logistics', requireAuth, singleFile(LOGISTIC_MIME), async (req, res) => {
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
      if (!isFileContentValid(req.file.buffer, req.file.mimetype)) {
        return res.status(400).json({ error: 'FORMAT_NOT_ALLOWED' })
      }
      const key = `logistics/${id}/${Date.now()}.${extensionFor(req.file.mimetype)}`
      fileUrl  = await uploadBufferToR2(req.file.buffer, key, req.file.mimetype)
      fileName = req.file.originalname
    }

    const [logistic] = await prisma.$queryRaw`
      INSERT INTO "BookingLogistic" ("bookingRequestId", type, title, "fileUrl", "fileName", "createdAt")
      VALUES (${id}, ${type}::"LogisticType", ${title.trim()}, ${fileUrl}, ${fileName}, NOW())
      RETURNING id, "bookingRequestId", type::text, title, "fileUrl", "fileName", "createdAt"
    `
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
    // Ne supprimer que si l'élément appartient bien à CE booking
    const deleted = await prisma.$executeRaw`DELETE FROM "BookingLogistic" WHERE id = ${logId} AND "bookingRequestId" = ${id}`
    if (!deleted) return res.status(404).json({ error: 'Élément introuvable' })
    res.json({ ok: true })
  } catch (err) {
    console.error('❌ bookingDetail DELETE /:id/logistics/:logId', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── POST /:id/media — upload un média promo ─────────────────────────────────
router.post('/:id/media', requireAuth, singleFile(MEDIA_MIME), async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  const result = await canAccessBooking(req.user.id, id)
  if (!result || !result.isOrganizer) return res.status(403).json({ error: 'Seul l\'organisateur peut ajouter un média' })

  if (!req.file) return res.status(400).json({ error: 'Fichier requis' })
  if (!isFileContentValid(req.file.buffer, req.file.mimetype)) {
    return res.status(400).json({ error: 'FORMAT_NOT_ALLOWED' })
  }

  try {
    const key       = `booking-media/${id}/${Date.now()}.${extensionFor(req.file.mimetype)}`
    const url       = await uploadBufferToR2(req.file.buffer, key, req.file.mimetype)
    const mediaType = req.file.mimetype.startsWith('video') ? 'VIDEO' : 'IMAGE'
    const name      = String(req.file.originalname || 'fichier').slice(0, 200)

    const [media] = await prisma.$queryRaw`
      INSERT INTO "BookingMedia" ("bookingRequestId", url, "mediaType", name, "createdAt")
      VALUES (${id}, ${url}, ${mediaType}, ${name}, NOW())
      RETURNING id, "bookingRequestId", url, "mediaType", name, "createdAt"
    `
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
    const deleted = await prisma.$executeRaw`DELETE FROM "BookingMedia" WHERE id = ${mediaId} AND "bookingRequestId" = ${id}`
    if (!deleted) return res.status(404).json({ error: 'Média introuvable' })
    res.json({ ok: true })
  } catch (err) {
    console.error('❌ bookingDetail DELETE /:id/media/:mediaId', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
