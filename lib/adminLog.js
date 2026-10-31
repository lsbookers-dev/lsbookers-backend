// lib/adminLog.js — Journal des actions admin (onglet « Historique » de l'admin)
//
// logAdmin(req, 'USER_BAN', { targetUserId, targetLabel, details }) : n'interrompt jamais l'action
// (une erreur d'écriture du journal est seulement signalée dans les logs).

const prisma = require('../prisma/client')

const clientIp = (req) => String(req?.ip || req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64) || null

/** « Prénom Nom (email) » ou pseudo, pour garder un nom lisible même après suppression du compte */
function userLabel(user) {
  if (!user) return null
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.pseudo || ''
  return (user.email ? (name ? `${name} (${user.email})` : user.email) : name).slice(0, 200) || null
}

/** Nom lisible d'un compte à partir de son id (avant une suppression, par exemple) */
async function labelForUser(id) {
  if (!id) return null
  const user = await prisma.user.findUnique({
    where: { id: Number(id) },
    select: { email: true, pseudo: true, firstName: true, lastName: true },
  }).catch(() => null)
  return userLabel(user)
}

async function logAdmin(req, action, { adminId, targetUserId = null, targetLabel = null, details = null } = {}) {
  try {
    const label = targetLabel ?? (targetUserId ? await labelForUser(targetUserId) : null)
    await prisma.adminLog.create({
      data: {
        adminId: adminId ?? req?.user?.id ?? null,
        action,
        targetUserId: targetUserId ? Number(targetUserId) : null,
        targetLabel: label ? String(label).slice(0, 200) : null,
        details: details ?? undefined,
        ip: clientIp(req),
      },
    })
  } catch (err) {
    console.error('Journal admin :', action, err.message)
  }
}

module.exports = { logAdmin, userLabel, labelForUser }
