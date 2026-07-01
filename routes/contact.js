// routes/contact.js
const express = require('express')
const router  = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const { requireAuth, requireAdmin } = require('../middleware/auth')

/* ─────────────────────────────────────────────
 * PUBLIC — Envoyer un message de contact
 * POST /api/contact
 * ───────────────────────────────────────────── */
router.post('/', async (req, res) => {
  const { name, email, subject, message } = req.body
  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'Nom, email et message sont requis.' })
  }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRe.test(email)) {
    return res.status(400).json({ error: 'Adresse email invalide.' })
  }
  try {
    const msg = await prisma.contactMessage.create({
      data: {
        name:    name.trim(),
        email:   email.trim().toLowerCase(),
        subject: subject?.trim() || null,
        message: message.trim(),
      },
    })
    return res.json({ ok: true, id: msg.id })
  } catch (err) {
    console.error('❌ POST /contact', err)
    return res.status(500).json({ error: 'Erreur serveur.' })
  }
})

/* ─────────────────────────────────────────────
 * ADMIN — Liste des messages (non archivés par défaut)
 * GET /api/contact/admin?archived=false&limit=50&offset=0
 * ───────────────────────────────────────────── */
router.get('/admin', requireAuth, requireAdmin, async (req, res) => {
  const archived = req.query.archived === 'true'
  const limit  = Math.min(100, parseInt(String(req.query.limit  || '50'), 10) || 50)
  const offset = Math.max(0,   parseInt(String(req.query.offset || '0'),  10) || 0)

  try {
    const where = { isArchived: archived }
    const [total, messages, unreadCount] = await Promise.all([
      prisma.contactMessage.count({ where }),
      prisma.contactMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.contactMessage.count({ where: { isRead: false, isArchived: false } }),
    ])
    return res.json({ total, messages, unreadCount })
  } catch (err) {
    console.error('❌ GET /contact/admin', err)
    return res.status(500).json({ error: 'Erreur serveur.' })
  }
})

/* ─────────────────────────────────────────────
 * ADMIN — Nombre de messages non lus (pour le badge)
 * GET /api/contact/admin/unread-count
 * ───────────────────────────────────────────── */
router.get('/admin/unread-count', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const count = await prisma.contactMessage.count({
      where: { isRead: false, isArchived: false },
    })
    return res.json({ count })
  } catch (err) {
    console.error('❌ GET /contact/admin/unread-count', err)
    return res.status(500).json({ error: 'Erreur serveur.' })
  }
})

/* ─────────────────────────────────────────────
 * ADMIN — Marquer comme lu
 * PATCH /api/contact/admin/:id/read
 * ───────────────────────────────────────────── */
router.patch('/admin/:id/read', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' })
  try {
    await prisma.contactMessage.update({ where: { id }, data: { isRead: true } })
    return res.json({ ok: true })
  } catch {
    return res.status(404).json({ error: 'Message introuvable.' })
  }
})

/* ─────────────────────────────────────────────
 * ADMIN — Archiver / désarchiver
 * PATCH /api/contact/admin/:id/archive
 * ───────────────────────────────────────────── */
router.patch('/admin/:id/archive', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' })
  const { archived } = req.body
  try {
    await prisma.contactMessage.update({
      where: { id },
      data: { isArchived: archived === true },
    })
    return res.json({ ok: true })
  } catch {
    return res.status(404).json({ error: 'Message introuvable.' })
  }
})

/* ─────────────────────────────────────────────
 * ADMIN — Supprimer
 * DELETE /api/contact/admin/:id
 * ───────────────────────────────────────────── */
router.delete('/admin/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' })
  try {
    await prisma.contactMessage.delete({ where: { id } })
    return res.json({ ok: true })
  } catch {
    return res.status(404).json({ error: 'Message introuvable.' })
  }
})

module.exports = router
