// routes/event-documents.js — Documents liés aux événements (contrats, transport, logement)
// Monté dans server.js sous /api/events (même préfixe que events.js)

const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');

// GET /api/events/:id/documents — lister les documents
router.get('/:id/documents', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });
    const documents = await prisma.eventDocument.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } });
    res.json({ documents });
  } catch (err) {
    console.error('GET documents:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/events/:id/documents — ajouter un document
router.post('/:id/documents', requireAuth, async (req, res) => {
  const { name, url, fileType } = req.body;
  if (!name?.trim() || !url?.trim()) return res.status(400).json({ error: 'Nom et URL requis' });
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });
    const document = await prisma.eventDocument.create({
      data: { eventId: event.id, name: name.trim(), url: url.trim(), fileType: fileType || 'OTHER' },
    });
    res.status(201).json({ document });
  } catch (err) {
    console.error('POST document:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/events/:id/documents/:docId — supprimer un document
router.delete('/:id/documents/:docId', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    const event = await prisma.event.findFirst({ where: { id: parseInt(req.params.id), profileId: profile.id } });
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });
    const deleted = await prisma.eventDocument.deleteMany({
      where: { id: parseInt(req.params.docId), eventId: event.id },
    });
    if (deleted.count !== 1) return res.status(404).json({ error: 'Document introuvable' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE document:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
