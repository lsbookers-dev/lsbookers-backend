// routes/bookingDetail.js — Détail d'un booking (logistique, médias, notes partagées)
const express  = require('express')
const router   = express.Router()
const prisma   = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { uploadBufferToR2, deleteR2Object } = require('../lib/r2')
const { isFileContentValid, extensionFor } = require('../lib/fileCheck')
const multer   = require('multer')
const { createNotif } = require('../services/notifications')
const { PERSON_SELECT, publicName, frenchDate } = require('../services/publicPerson')

// Types acceptés : logistique = billets / réservations (PDF ou photo), médias promo = images / vidéos
const LOGISTIC_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
const CONTRACT_MIME = new Set(['application/pdf'])
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
    return { booking, isOrganizer: isRequester, myProfileId: isRequester ? booking.requesterId : booking.targetId }
  } catch (err) {
    console.error('❌ canAccessBooking error:', err)
    return null
  }
}

// ─── Prévenir l'autre partie qu'un élément a été ajouté au booking ──────────────
// what : début de phrase, ex. « Un contrat a été ajouté »
async function notifyBookingItem(access, actorUserId, what) {
  const { booking, isOrganizer } = access
  const recipientUserId = isOrganizer ? booking.target.user.id : booking.requester.user.id
  const actor = await prisma.profile.findUnique({ where: { id: access.myProfileId }, select: PERSON_SELECT })
  await createNotif({
    userId: recipientUserId,
    type: 'BOOKING_ITEM_ADDED',
    content: `${what} à votre booking du ${frenchDate(booking.startDate)} par ${publicName(actor)}`,
    actorId: actorUserId,
    eventId: booking.eventId,
  })
}

const LOGISTIC_LABEL = {
  TRANSPORT: 'Un billet de transport a été ajouté',
  HOTEL: 'Une réservation d’hébergement a été ajoutée',
}

// ─── Contrats propres à un booking (table Contract, liés à l'événement + aux 2 profils) ──
async function bookingContracts(booking) {
  if (!booking.eventId) return []
  return prisma.contract.findMany({
    where: {
      eventId: booking.eventId,
      OR: [
        { senderId: booking.requesterId, recipientId: booking.targetId },
        { senderId: booking.targetId, recipientId: booking.requesterId },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, fileUrl: true, senderId: true, createdAt: true },
  })
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
      SELECT id, "bookingRequestId", type::text, title, "fileUrl", "fileName", "addedByProfileId", "createdAt"
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

    const contracts = await bookingContracts(booking)

    res.json({
      booking: { ...booking, logistics, media, contracts },
      isOrganizer: result.isOrganizer,
      myProfileId: result.myProfileId,
    })
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

  // Organisateur et personne bookée peuvent ajouter leurs billets / réservations
  const result = await canAccessBooking(req.user.id, id)
  if (!result) return res.status(403).json({ error: 'Accès refusé' })

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
      INSERT INTO "BookingLogistic" ("bookingRequestId", type, title, "fileUrl", "fileName", "addedByProfileId", "createdAt")
      VALUES (${id}, ${type}::"LogisticType", ${title.trim().slice(0, 200)}, ${fileUrl}, ${fileName}, ${result.myProfileId}, NOW())
      RETURNING id, "bookingRequestId", type::text, title, "fileUrl", "fileName", "addedByProfileId", "createdAt"
    `
    await notifyBookingItem(result, req.user.id, LOGISTIC_LABEL[type])
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
  if (!result) return res.status(403).json({ error: 'Accès refusé' })

  try {
    // Chacun supprime ses propres éléments ; l'organisateur garde la main sur les anciens (sans auteur)
    const deleted = result.isOrganizer
      ? await prisma.$executeRaw`DELETE FROM "BookingLogistic" WHERE id = ${logId} AND "bookingRequestId" = ${id} AND ("addedByProfileId" = ${result.myProfileId} OR "addedByProfileId" IS NULL)`
      : await prisma.$executeRaw`DELETE FROM "BookingLogistic" WHERE id = ${logId} AND "bookingRequestId" = ${id} AND "addedByProfileId" = ${result.myProfileId}`
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
    await notifyBookingItem(result, req.user.id, mediaType === 'VIDEO' ? 'Une vidéo a été ajoutée' : 'Une photo a été ajoutée')
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

// ─── POST /:id/contracts — déposer un contrat PDF (organisateur ou personne bookée) ──
router.post('/:id/contracts', requireAuth, singleFile(CONTRACT_MIME), async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' })

  const result = await canAccessBooking(req.user.id, id)
  if (!result) return res.status(403).json({ error: 'Accès refusé' })
  const { booking } = result
  if (!booking.eventId) return res.status(400).json({ error: 'Le booking doit être confirmé avant d\'ajouter un contrat' })
  if (!req.file) return res.status(400).json({ error: 'Fichier requis' })
  if (!isFileContentValid(req.file.buffer, req.file.mimetype)) {
    return res.status(400).json({ error: 'FORMAT_NOT_ALLOWED' })
  }

  try {
    const key     = `documents/contracts/${id}/${Date.now()}.${extensionFor(req.file.mimetype)}`
    const fileUrl = await uploadBufferToR2(req.file.buffer, key, req.file.mimetype)
    const recipientId = result.isOrganizer ? booking.targetId : booking.requesterId
    const contract = await prisma.contract.create({
      data: {
        title: String(req.file.originalname || 'Contrat.pdf').slice(0, 200),
        fileUrl,
        amount: booking.fee ?? null,
        senderId: result.myProfileId,
        recipientId,
        eventId: booking.eventId,
      },
      select: { id: true, title: true, fileUrl: true, senderId: true, createdAt: true },
    })
    await notifyBookingItem(result, req.user.id, 'Un contrat a été ajouté')
    res.status(201).json({ contract })
  } catch (err) {
    console.error('❌ bookingDetail POST /:id/contracts', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── DELETE /:id/contracts/:contractId — seul l'auteur peut retirer son contrat ──
router.delete('/:id/contracts/:contractId', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  const contractId = parseInt(req.params.contractId, 10)
  if (isNaN(id) || isNaN(contractId)) return res.status(400).json({ error: 'ID invalide' })

  const result = await canAccessBooking(req.user.id, id)
  if (!result) return res.status(403).json({ error: 'Accès refusé' })

  try {
    const contract = (await bookingContracts(result.booking)).find(c => c.id === contractId)
    if (!contract || contract.senderId !== result.myProfileId) return res.status(404).json({ error: 'Contrat introuvable' })
    await prisma.contract.delete({ where: { id: contract.id } })
    await deleteR2Object(contract.fileUrl)
    res.json({ ok: true })
  } catch (err) {
    console.error('❌ bookingDetail DELETE /:id/contracts/:contractId', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
module.exports.bookingContracts = bookingContracts
