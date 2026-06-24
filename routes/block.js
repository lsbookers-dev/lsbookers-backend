const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const { requireAuth } = require('../middleware/auth')

/* =========================================================
 *  POST /api/block/:id  — Bloquer un utilisateur
 *  - Crée le bloc
 *  - Supprime le follow mutuel
 * =======================================================*/
router.post('/:id', requireAuth, async (req, res) => {
  const blockerId = req.user.id
  const blockedId = parseInt(req.params.id, 10)

  if (!Number.isFinite(blockedId)) return res.status(400).json({ error: 'ID invalide' })
  if (blockerId === blockedId) return res.status(400).json({ error: 'Impossible de se bloquer soi-même' })

  try {
    const target = await prisma.user.findUnique({ where: { id: blockedId }, select: { id: true } })
    if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' })

    // Créer le bloc (upsert pour éviter les doublons)
    await prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId },
      update: {},
    })

    // Supprimer les follows dans les deux sens
    await prisma.follow.deleteMany({
      where: {
        OR: [
          { followerId: blockerId, followingId: blockedId },
          { followerId: blockedId, followingId: blockerId },
        ],
      },
    })

    return res.json({ ok: true })
  } catch (error) {
    console.error('Erreur block :', error)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
 *  DELETE /api/block/:id  — Débloquer un utilisateur
 * =======================================================*/
router.delete('/:id', requireAuth, async (req, res) => {
  const blockerId = req.user.id
  const blockedId = parseInt(req.params.id, 10)

  if (!Number.isFinite(blockedId)) return res.status(400).json({ error: 'ID invalide' })

  try {
    await prisma.block.deleteMany({ where: { blockerId, blockedId } })
    return res.json({ ok: true })
  } catch (error) {
    console.error('Erreur unblock :', error)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
 *  GET /api/block/status/:id  — Est-ce que j'ai bloqué ce user ?
 * =======================================================*/
router.get('/status/:id', requireAuth, async (req, res) => {
  const blockerId = req.user.id
  const blockedId = parseInt(req.params.id, 10)

  if (!Number.isFinite(blockedId)) return res.status(400).json({ error: 'ID invalide' })

  try {
    const block = await prisma.block.findUnique({
      where: { blockerId_blockedId: { blockerId, blockedId } },
    })
    return res.json({ blocked: !!block })
  } catch (error) {
    console.error('Erreur block status :', error)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
 *  GET /api/block/list  — Liste des IDs que j'ai bloqués
 * =======================================================*/
router.get('/list', requireAuth, async (req, res) => {
  try {
    const blocks = await prisma.block.findMany({
      where: { blockerId: req.user.id },
      select: { blockedId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({ blocked: blocks.map(b => b.blockedId) })
  } catch (error) {
    console.error('Erreur block list :', error)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
