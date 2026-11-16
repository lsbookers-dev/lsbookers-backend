// routes/quotes.js — Devis (Mon espace › Devis)
//
// - Organisateur : les devis reçus (envoyés depuis ses offres) + ceux qu'il dépose lui-même
// - Artiste / prestataire : les devis envoyés depuis les offres + ceux qu'il dépose lui-même
// LS Bookers n'édite plus de devis à son logo (décision d'Antho, 14/11/2026) : on ne garde que le document.
//
//   GET    /api/quotes                    mes devis (envoyés, reçus, déposés)
//   POST   /api/quotes/from-message       devis envoyé depuis une offre (PDF joint au message)
//   POST   /api/quotes/upload             déposer un devis (PDF déjà envoyé sur le stockage)
//   DELETE /api/quotes/:id                retirer un devis que j'ai déposé

const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { isOwnMediaUrl } = require('../lib/mediaUrl')

const PERSON = { select: { id: true, userId: true, avatar: true, user: { select: { pseudo: true, firstName: true, lastName: true, role: true } } } }
const nameOf = (p) => p ? (p.user?.pseudo || [p.user?.firstName, p.user?.lastName].filter(Boolean).join(' ') || 'Membre') : null
const myProfile = (req) => prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } })

function toClient(q, meId) {
  const direction = q.uploadedByProfileId === meId ? 'UPLOADED' : q.recipientProfileId === meId ? 'RECEIVED' : 'SENT'
  const other = direction === 'RECEIVED' ? q.sender : direction === 'SENT' ? q.recipient : null
  return {
    id: q.id, direction, title: q.title, fileUrl: q.fileUrl, fileName: q.fileName, amount: q.amount, offerId: q.offerId, createdAt: q.createdAt,
    counterpart: other ? { name: nameOf(other), userId: other.userId, avatar: other.avatar, role: other.user?.role } : (q.counterpartName ? { name: q.counterpartName } : null),
  }
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const me = await myProfile(req)
    if (!me) return res.status(404).json({ error: 'Profil introuvable' })
    const quotes = await prisma.quote.findMany({
      where: { OR: [{ senderProfileId: me.id }, { recipientProfileId: me.id }, { uploadedByProfileId: me.id }] },
      include: { sender: PERSON, recipient: PERSON },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    res.json({ quotes: quotes.map(q => toClient(q, me.id)) })
  } catch (err) {
    console.error('GET /quotes', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// Devis envoyé depuis une offre : le document est la pièce jointe du message, envoyé par moi
router.post('/from-message', requireAuth, async (req, res) => {
  try {
    const me = await myProfile(req)
    const messageId = Number(req.body?.messageId)
    if (!me || !Number.isInteger(messageId)) return res.status(400).json({ error: 'Message invalide' })
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, senderId: true, attachmentUrl: true, attachmentName: true, conversation: { select: { participants: { select: { userId: true } } } } },
    })
    if (!msg || msg.senderId !== req.user.id || !msg.attachmentUrl) return res.status(404).json({ error: 'Devis introuvable' })
    const otherUserId = msg.conversation.participants.map(p => p.userId).find(id => id !== req.user.id)
    const recipient = otherUserId ? await prisma.profile.findUnique({ where: { userId: otherUserId }, select: { id: true } }) : null
    const offerId = Number(req.body?.offerId) || null
    const offer = offerId ? await prisma.offer.findUnique({ where: { id: offerId }, select: { title: true } }) : null
    const existing = await prisma.quote.findFirst({ where: { messageId: msg.id }, select: { id: true } })
    if (existing) return res.json({ ok: true })
    await prisma.quote.create({
      data: {
        senderProfileId: me.id, recipientProfileId: recipient?.id ?? null, offerId, messageId: msg.id,
        title: offer ? `Devis · ${offer.title}` : 'Devis', fileUrl: msg.attachmentUrl, fileName: msg.attachmentName,
        amount: Number.isFinite(Number(req.body?.amount)) && Number(req.body.amount) > 0 ? Number(req.body.amount) : null,
      },
    })
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('POST /quotes/from-message', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// Déposer un devis : le PDF est déjà sur le stockage (envoi direct, dossier « documents »)
router.post('/upload', requireAuth, async (req, res) => {
  try {
    const me = await myProfile(req)
    if (!me) return res.status(404).json({ error: 'Profil introuvable' })
    const { fileUrl, fileName, title, counterpartName, amount } = req.body || {}
    if (!fileUrl || !isOwnMediaUrl(fileUrl)) return res.status(400).json({ error: 'Document invalide' })
    const quote = await prisma.quote.create({
      data: {
        uploadedByProfileId: me.id, fileUrl, fileName: fileName ? String(fileName).slice(0, 200) : null,
        title: String(title || '').trim().slice(0, 150) || 'Devis',
        counterpartName: counterpartName ? String(counterpartName).trim().slice(0, 120) : null,
        amount: Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : null,
      },
      include: { sender: PERSON, recipient: PERSON },
    })
    res.status(201).json({ quote: toClient(quote, me.id) })
  } catch (err) {
    console.error('POST /quotes/upload', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const me = await myProfile(req)
    const deleted = me ? await prisma.quote.deleteMany({ where: { id: Number(req.params.id), uploadedByProfileId: me.id } }) : { count: 0 }
    if (!deleted.count) return res.status(404).json({ error: 'Devis introuvable' })
    res.json({ ok: true })
  } catch (err) {
    console.error('DELETE /quotes/:id', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
