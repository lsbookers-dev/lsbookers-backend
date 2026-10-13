// routes/checklists.js — Checklist facultative d'un événement (monté sur /api/events)
// Chaque personne (organisateur de l'événement ou personne bookée dessus) peut ajouter
// SA checklist : une liste de départ selon son rôle, puis libre (cocher, ajouter, retirer).
const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')

const TEMPLATES = {
  ORGANIZER: ['Contrat signé', 'Acompte versé', 'Fiche technique reçue', 'Transport et hébergement réservés', 'Solde payé'],
  BOOKED: ['Contrat signé', 'Acompte reçu', 'Fiche technique envoyée', 'Transport réservé', 'Hébergement réservé', 'Paiement reçu'],
}

const clean = (label) => String(label || '').trim().replace(/<[^>]*>/g, '').slice(0, 120)

/** Accès : organisateur de l'événement, ou personne confirmée dans son équipe. */
async function access(req) {
  const eventId = Number.parseInt(req.params.id, 10)
  if (Number.isNaN(eventId)) return null
  const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } })
  if (!profile) return null
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, profileId: true } })
  if (!event) return null
  if (event.profileId === profile.id) return { eventId, profileId: profile.id, as: 'ORGANIZER' }
  const staff = await prisma.eventStaff.findFirst({ where: { eventId, profileId: profile.id, status: 'BOOKED' }, select: { id: true } })
  return staff ? { eventId, profileId: profile.id, as: 'BOOKED' } : null
}

const load = (eventId, profileId) => prisma.eventChecklist.findUnique({
  where: { eventId_profileId: { eventId, profileId } },
  include: { items: { orderBy: [{ position: 'asc' }, { id: 'asc' }] } },
})

// GET /api/events/:id/checklist — ma checklist (null si je n'en ai pas ajouté)
router.get('/:id/checklist', requireAuth, async (req, res) => {
  try {
    const a = await access(req)
    if (!a) return res.status(403).json({ error: 'Accès refusé' })
    return res.json({ checklist: await load(a.eventId, a.profileId) })
  } catch (err) {
    console.error('❌ GET checklist :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/events/:id/checklist — ajouter ma checklist (liste de départ selon le rôle)
router.post('/:id/checklist', requireAuth, async (req, res) => {
  try {
    const a = await access(req)
    if (!a) return res.status(403).json({ error: 'Accès refusé' })
    const existing = await load(a.eventId, a.profileId)
    if (existing) return res.json({ checklist: existing })
    await prisma.eventChecklist.create({
      data: {
        eventId: a.eventId,
        profileId: a.profileId,
        items: { create: TEMPLATES[a.as].map((label, position) => ({ label, position })) },
      },
    })
    return res.status(201).json({ checklist: await load(a.eventId, a.profileId) })
  } catch (err) {
    console.error('❌ POST checklist :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// DELETE /api/events/:id/checklist — retirer ma checklist
router.delete('/:id/checklist', requireAuth, async (req, res) => {
  try {
    const a = await access(req)
    if (!a) return res.status(403).json({ error: 'Accès refusé' })
    await prisma.eventChecklist.deleteMany({ where: { eventId: a.eventId, profileId: a.profileId } })
    return res.json({ ok: true })
  } catch (err) {
    console.error('❌ DELETE checklist :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/events/:id/checklist/items — ajouter un élément { label }
router.post('/:id/checklist/items', requireAuth, async (req, res) => {
  try {
    const a = await access(req)
    if (!a) return res.status(403).json({ error: 'Accès refusé' })
    const label = clean(req.body?.label)
    if (!label) return res.status(400).json({ error: 'Intitulé requis' })
    const checklist = await load(a.eventId, a.profileId)
    if (!checklist) return res.status(404).json({ error: 'Ajoutez d’abord une checklist' })
    if (checklist.items.length >= 30) return res.status(400).json({ error: '30 éléments maximum' })
    const item = await prisma.eventChecklistItem.create({
      data: { checklistId: checklist.id, label, position: checklist.items.length },
    })
    return res.status(201).json({ item })
  } catch (err) {
    console.error('❌ POST checklist item :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// PATCH /api/events/:id/checklist/items/:itemId — { done?, label? }
router.patch('/:id/checklist/items/:itemId', requireAuth, async (req, res) => {
  try {
    const a = await access(req)
    if (!a) return res.status(403).json({ error: 'Accès refusé' })
    const itemId = Number.parseInt(req.params.itemId, 10)
    const data = {}
    if (typeof req.body?.done === 'boolean') data.done = req.body.done
    if (req.body?.label !== undefined) {
      const label = clean(req.body.label)
      if (!label) return res.status(400).json({ error: 'Intitulé requis' })
      data.label = label
    }
    const { count } = await prisma.eventChecklistItem.updateMany({
      where: { id: itemId, checklist: { eventId: a.eventId, profileId: a.profileId } },
      data,
    })
    if (!count) return res.status(404).json({ error: 'Élément introuvable' })
    return res.json({ ok: true })
  } catch (err) {
    console.error('❌ PATCH checklist item :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// DELETE /api/events/:id/checklist/items/:itemId
router.delete('/:id/checklist/items/:itemId', requireAuth, async (req, res) => {
  try {
    const a = await access(req)
    if (!a) return res.status(403).json({ error: 'Accès refusé' })
    const itemId = Number.parseInt(req.params.itemId, 10)
    const { count } = await prisma.eventChecklistItem.deleteMany({
      where: { id: itemId, checklist: { eventId: a.eventId, profileId: a.profileId } },
    })
    if (!count) return res.status(404).json({ error: 'Élément introuvable' })
    return res.json({ ok: true })
  } catch (err) {
    console.error('❌ DELETE checklist item :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
module.exports.TEMPLATES = TEMPLATES
