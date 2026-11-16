// routes/reports.js — Signaler un profil, une publication, un commentaire ou une offre
const express = require('express')
const router = express.Router()
const { requireAuth } = require('../middleware/auth')
const { createReport, REASONS, ModerationError } = require('../services/moderation')

/* GET /api/reports/reasons — motifs proposés dans la fenêtre de signalement */
router.get('/reasons', (_req, res) => {
  res.json({ reasons: Object.entries(REASONS).map(([key, label]) => ({ key, label })) })
})

/* POST /api/reports { targetType, targetId, reason, details } */
router.post('/', requireAuth, async (req, res) => {
  try {
    const result = await createReport({
      reporterId: req.user.id,
      targetType: String(req.body?.targetType || '').toUpperCase(),
      targetId: Number.parseInt(req.body?.targetId, 10),
      reason: String(req.body?.reason || '').toUpperCase(),
      details: typeof req.body?.details === 'string' ? req.body.details : '',
    })
    return res.json(result)
  } catch (err) {
    if (err instanceof ModerationError) return res.status(err.status).json({ error: err.message, code: err.code })
    console.error('❌ POST /reports', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
