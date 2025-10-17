// backend/routes/password.js
const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const bcrypt = require('bcrypt')
const crypto = require('crypto')
const nodemailer = require('nodemailer')

const APP_URL = process.env.APP_URL || 'http://localhost:3000'

// --- Mailer (SMTP optionnel) ---
function getTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) return null
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  })
}

async function sendResetEmail(to, resetLink) {
  const transporter = getTransport()
  const from = process.env.SMTP_FROM || 'LSBookers <no-reply@lsbookers.local>'
  const subject = 'Réinitialisation de ton mot de passe — LSBookers'
  const html = `
    <div style="font-family:Arial,sans-serif;color:#111">
      <h2>Réinitialise ton mot de passe</h2>
      <p>Tu as demandé la réinitialisation de ton mot de passe LSBookers.</p>
      <p>Clique sur le bouton ci-dessous (valide 1h) :</p>
      <p><a href="${resetLink}" style="display:inline-block;background:#10b981;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Réinitialiser</a></p>
      <p>Si tu n’es pas à l’origine de cette demande, ignore cet email.</p>
      <hr/>
      <p style="font-size:12px;color:#666">${resetLink}</p>
    </div>
  `
  if (!transporter) {
    // Pas de SMTP configuré → on log le lien en console (utile en dev/prod test)
    console.log('📧 [DEV] Email reset (no SMTP):', { to, resetLink })
    return
  }
  await transporter.sendMail({ from, to, subject, html })
}

// --- Helpers ---
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

// POST /api/auth/forgot-password  { email }
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {}
  // Réponse générique pour éviter d'indiquer si l'email existe
  const generic = { message: 'Si un compte existe, un email sera envoyé.' }

  if (!email || typeof email !== 'string') {
    return res.status(200).json(generic)
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return res.status(200).json(generic)

    // Invalide les anciens tokens non utilisés (optionnel)
    await prisma.passwordReset.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    })

    // Crée un token
    const token = crypto.randomBytes(32).toString('hex')
    const tokenHash = sha256Hex(token)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1h

    await prisma.passwordReset.create({
      data: { userId: user.id, tokenHash, expiresAt },
    })

    const resetLink = `${APP_URL}/reset-password?token=${token}`
    await sendResetEmail(user.email, resetLink)

    return res.status(200).json(generic)
  } catch (e) {
    console.error('forgot-password error', e)
    return res.status(200).json(generic)
  }
})

// POST /api/auth/reset-password  { token, password }
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body || {}
  if (!token || !password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ message: 'Données invalides.' })
  }

  try {
    const tokenHash = sha256Hex(token)
    const pr = await prisma.passwordReset.findUnique({ where: { tokenHash } })

    if (!pr || pr.usedAt || pr.expiresAt < new Date()) {
      return res.status(400).json({ message: 'Lien invalide ou expiré.' })
    }

    // Update password
    const hash = await bcrypt.hash(password, 10)
    await prisma.user.update({
      where: { id: pr.userId },
      data: { password: hash },
    })

    // Marque le token comme utilisé
    await prisma.passwordReset.update({
      where: { tokenHash },
      data: { usedAt: new Date() },
    })

    return res.json({ message: 'Mot de passe réinitialisé avec succès.' })
  } catch (e) {
    console.error('reset-password error', e)
    return res.status(500).json({ message: 'Erreur serveur.' })
  }
})

module.exports = router