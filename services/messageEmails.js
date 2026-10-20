// services/messageEmails.js — E-mail « nouveau message » (Réglages › Notifications et e-mails › Messages)
//
// Envoyé seulement si le destinataire n'est pas sur le site (aucune activité depuis 10 min),
// n'a pas mis la conversation en sourdine, et au plus une fois par heure et par conversation.

const prisma = require('../prisma/client')
const { resolvePrefs } = require('../lib/notifPrefs')
const { displayName } = require('./notifications')

const AWAY_AFTER_MS = 10 * 60 * 1000
const ONE_EMAIL_EVERY_MS = 60 * 60 * 1000

const emails = () => require('../utils/email')

async function notifyNewMessageByEmail({ conversationId, senderId }) {
  try {
    const now = Date.now()
    const [sender, participants] = await Promise.all([
      prisma.user.findUnique({ where: { id: Number(senderId) }, select: { pseudo: true, firstName: true, lastName: true } }),
      prisma.conversationParticipant.findMany({
        where: { conversationId: Number(conversationId), userId: { not: Number(senderId) }, muted: false },
        select: {
          id: true, lastEmailedAt: true,
          user: { select: { email: true, notifPrefs: true, lastActiveAt: true, emailVerified: true } },
        },
      }),
    ])

    for (const p of participants) {
      const u = p.user
      if (!u?.email || !u.emailVerified) continue
      if (!resolvePrefs(u.notifPrefs).messages.email) continue
      if (u.lastActiveAt && now - new Date(u.lastActiveAt).getTime() < AWAY_AFTER_MS) continue
      if (p.lastEmailedAt && now - new Date(p.lastEmailedAt).getTime() < ONE_EMAIL_EVERY_MS) continue

      await prisma.conversationParticipant.update({ where: { id: p.id }, data: { lastEmailedAt: new Date() } })
      emails().sendNewMessageEmail(u.email, { senderName: displayName(sender), conversationId })
        .catch(err => console.error('❌ [messageEmails] envoi :', err.message))
    }
  } catch (err) {
    console.error('❌ [messageEmails] :', err.message)
  }
}

module.exports = { notifyNewMessageByEmail }
