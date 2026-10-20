// lib/messagePolicy.js — Qui peut démarrer une conversation avec un membre (Réglages › Confidentialité)
//
// S'applique seulement à une NOUVELLE conversation : une conversation déjà ouverte continue.
// Les parcours de booking (candidature, demande liée à un événement) ne passent pas par ici.

const prisma = require('../prisma/client')

/** null si le contact est permis, sinon { status, error, code } à renvoyer */
async function newConversationRefusal(senderId, recipientId) {
  const recipient = await prisma.user.findUnique({
    where: { id: Number(recipientId) },
    select: { pausedAt: true, profile: { select: { messagePolicy: true } } },
  })
  if (!recipient) return null
  if (recipient.pausedAt) {
    return { status: 403, code: 'ACCOUNT_PAUSED', error: 'Ce compte est en pause : il ne reçoit pas de nouveaux messages pour le moment.' }
  }
  if (recipient.profile?.messagePolicy === 'FOLLOWED') {
    const follows = await prisma.follow.findFirst({
      where: { followerId: Number(recipientId), followingId: Number(senderId) },
      select: { id: true },
    })
    if (!follows) {
      return { status: 403, code: 'MESSAGES_RESTRICTED', error: 'Ce membre ne reçoit des messages que des personnes qu’il suit.' }
    }
  }
  return null
}

module.exports = { newConversationRefusal }
