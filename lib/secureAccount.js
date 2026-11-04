// lib/secureAccount.js — « Ce n'était pas moi » (e-mail d'alerte de nouvelle connexion, 04/11/2026)
//
// Le lien de l'e-mail porte un jeton signé, valable 7 jours, utilisable SANS être connecté.
// Il ne sert qu'une fois : il contient la « version » du compte, qui change dès qu'on l'utilise
// (et aussi à chaque changement de mot de passe ou « se déconnecter partout »).
// Effet : tous les appareils sont déconnectés, le mot de passe doit être changé, et un e-mail
// de réinitialisation part tout de suite.

const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const prisma = require('../prisma/client')

const PURPOSE = 'secure-account'
const RESET_TTL_MS = 60 * 60 * 1000 // lien de nouveau mot de passe : 1 h (comme « mot de passe oublié »)

function signSecureAccountToken(user) {
  return jwt.sign({ uid: user.id, tv: user.tokenVersion, purpose: PURPOSE }, process.env.JWT_SECRET, { expiresIn: '7d' })
}

/** Vérifie le lien ; renvoie l'utilisateur concerné, ou null si le lien est invalide, expiré ou déjà utilisé */
async function userFromSecureToken(token) {
  let decoded
  try {
    decoded = jwt.verify(String(token || ''), process.env.JWT_SECRET)
  } catch {
    return null
  }
  if (decoded?.purpose !== PURPOSE || !Number.isInteger(decoded.uid)) return null
  const user = await prisma.user.findUnique({ where: { id: decoded.uid }, select: { id: true, email: true, tokenVersion: true } })
  if (!user || user.tokenVersion !== decoded.tv) return null
  return user
}

/** Sécurise le compte : tout déconnecter, bloquer la connexion jusqu'au nouveau mot de passe, envoyer le lien */
async function secureAccount(user) {
  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  await prisma.$transaction([
    prisma.userSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 }, requiresPasswordReset: true } }),
    prisma.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.passwordReset.create({
      data: { id: crypto.randomBytes(16).toString('hex'), userId: user.id, tokenHash, expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    }),
  ])
  await require('../utils/email').sendPasswordResetEmail(user.email, token)
}

module.exports = { signSecureAccountToken, userFromSecureToken, secureAccount }
