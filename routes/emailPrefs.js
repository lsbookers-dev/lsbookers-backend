// routes/emailPrefs.js — Désinscription des e-mails de notification en un clic (04/11/2026)
//
// Le lien vient de l'e-mail lui-même (jeton signé, sans connexion) :
//   - GET  /api/email/unsubscribe/info?token=…  → quels e-mails ce lien arrête (page /desinscription du site)
//   - POST /api/email/unsubscribe?token=…       → arrête ces e-mails (bouton de la page, ou Gmail / Yahoo
//     directement grâce à l'en-tête List-Unsubscribe). Rien d'autre n'est modifié.

const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { readUnsubscribeToken, categoryLabel } = require('../lib/notificationEmail')

const tokenOf = (req) => req.query?.token || req.body?.token

router.get('/unsubscribe/info', async (req, res) => {
  const parsed = readUnsubscribeToken(tokenOf(req))
  if (!parsed) return res.status(400).json({ error: 'Ce lien n’est pas valable.' })
  res.json({ categories: parsed.categories.map(key => ({ key, label: categoryLabel(key) })) })
})

router.post('/unsubscribe', async (req, res) => {
  try {
    const parsed = readUnsubscribeToken(tokenOf(req))
    if (!parsed) return res.status(400).json({ error: 'Ce lien n’est pas valable.' })
    const user = await prisma.user.findUnique({ where: { id: parsed.userId }, select: { id: true, notifPrefs: true } })
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' })
    const prefs = { ...(user.notifPrefs || {}) }
    for (const key of parsed.categories) prefs[key] = { ...(prefs[key] || {}), email: false }
    await prisma.user.update({ where: { id: user.id }, data: { notifPrefs: prefs } })
    res.json({ ok: true, categories: parsed.categories.map(key => ({ key, label: categoryLabel(key) })) })
  } catch (err) {
    console.error('❌ [POST /email/unsubscribe] Error:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
