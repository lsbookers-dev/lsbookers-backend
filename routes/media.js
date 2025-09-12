// routes/media.js
const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticate = require('../middleware/authenticate');

/**
 * MODELE PRISMA ATTENDU (à titre indicatif) :
 * model Media {
 *   id         Int      @id @default(autoincrement())
 *   userId     Int
 *   title      String
 *   url        String
 *   caption    String?   // optionnel
 *   createdAt  DateTime  @default(now())
 *   user       User      @relation(fields: [userId], references: [id])
 *   // (optionnel) profileId Int?
 * }
 */

/* ============================================
 * GET /api/media/user/:userId
 * Liste publique des publications d'un utilisateur
 * ============================================ */
router.get('/user/:userId', async (req, res) => {
  const userId = Number.parseInt(req.params.userId, 10);
  if (Number.isNaN(userId)) {
    return res.status(400).json({ error: 'userId invalide' });
  }

  try {
    const items = await prisma.media.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, url: true, caption: true, createdAt: true },
    });

    // Normalisation simple pour le front (image=url)
    const publications = items.map((m) => ({
      id: m.id,
      title: m.title,
      image: m.url,
      caption: m.caption || null,
      createdAt: m.createdAt,
    }));

    return res.json({ publications });
  } catch (err) {
    console.error('❌ /media/user/:userId', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ============================================
 * POST /api/media
 * Créer une publication (auth requise)
 * Body: { title: string, url: string, caption?: string }
 * ============================================ */
router.post('/', authenticate, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { title, url, caption } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title requis' });
    }
    if (!url || !String(url).trim()) {
      return res.status(400).json({ error: 'url requis' });
    }

    const created = await prisma.media.create({
      data: {
        userId,
        title: String(title),
        url: String(url),
        caption: caption ? String(caption) : null,
      },
      select: { id: true, title: true, url: true, caption: true, createdAt: true },
    });

    return res.json({
      publication: {
        id: created.id,
        title: created.title,
        image: created.url,
        caption: created.caption,
        createdAt: created.createdAt,
      },
    });
  } catch (err) {
    console.error('❌ POST /media', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ============================================
 * DELETE /api/media/:id
 * Supprimer une publication (propriétaire uniquement)
 * ============================================ */
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const id = Number.parseInt(req.params.id, 10);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (Number.isNaN(id)) return res.status(400).json({ error: 'id invalide' });

    const media = await prisma.media.findUnique({ where: { id } });
    if (!media) return res.status(404).json({ error: 'Publication introuvable' });
    if (media.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    await prisma.media.delete({ where: { id } });
    return res.status(204).end();
  } catch (err) {
    console.error('❌ DELETE /media/:id', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;