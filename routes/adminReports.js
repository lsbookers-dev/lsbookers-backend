// routes/adminReports.js — Admin › Signalements : liste et décisions
const express = require('express')
const router = express.Router()
const { requireAuth, requireAdmin } = require('../middleware/auth')
const { listReports, resolveReports, REASONS, ModerationError } = require('../services/moderation')
const { logAdmin } = require('../lib/adminLog')

router.use(requireAuth, requireAdmin)

// Action enregistrée dans l'Historique pour chaque décision
const LOG_ACTION = { DISMISS: 'REPORT_DISMISS', REMOVE: 'CONTENT_REMOVE', WARN: 'MEMBER_WARN', BAN: 'USER_BAN' }

/* GET /api/admin/reports?status=pending|done */
router.get('/', async (req, res) => {
  try {
    const status = req.query.status === 'done' ? 'done' : 'pending'
    return res.json({ status, items: await listReports(status), reasons: REASONS })
  } catch (err) {
    console.error('❌ GET /admin/reports', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* POST /api/admin/reports/resolve { targetType, targetId, action, reason?, note?, warn? } */
router.post('/resolve', async (req, res) => {
  try {
    const result = await resolveReports({
      adminId: req.user.id,
      targetType: String(req.body?.targetType || '').toUpperCase(),
      targetId: Number.parseInt(req.body?.targetId, 10),
      action: String(req.body?.action || '').toUpperCase(),
      reason: String(req.body?.reason || '').toUpperCase(),
      note: typeof req.body?.note === 'string' ? req.body.note : '',
      warn: req.body?.warn === true,
    })
    await logAdmin(req, LOG_ACTION[result.action], {
      targetUserId: result.targetUserId,
      details: { contenu: result.label, motif: REASONS[result.reason], signalements: result.count, avertissement: result.warned || undefined, message: req.body?.note || undefined },
    })
    return res.json({ ok: true, status: result.status })
  } catch (err) {
    if (err instanceof ModerationError) return res.status(err.status).json({ error: err.message, code: err.code })
    console.error('❌ POST /admin/reports/resolve', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
