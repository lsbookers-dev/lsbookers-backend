// lib/blocks.js — Règles de blocage entre utilisateurs (dans les deux sens)
const prisma = require('../prisma/client')

/** Vrai si l'un des deux utilisateurs a bloqué l'autre */
async function isBlockedBetween(userA, userB) {
  if (!userA || !userB || userA === userB) return false
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userA, blockedId: userB },
        { blockerId: userB, blockedId: userA },
      ],
    },
    select: { id: true },
  })
  return !!block
}

/** Ids des utilisateurs bloqués par userId ou qui ont bloqué userId */
async function getBlockedUserIds(userId) {
  if (!userId) return []
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  })
  return [...new Set(blocks.map(b => (b.blockerId === userId ? b.blockedId : b.blockerId)))]
}

/** Ids des profils des utilisateurs bloqués (pour filtrer publications, commentaires...) */
async function getBlockedProfileIds(userId) {
  const userIds = await getBlockedUserIds(userId)
  if (!userIds.length) return []
  const profiles = await prisma.profile.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  })
  return profiles.map(p => p.id)
}

module.exports = { isBlockedBetween, getBlockedUserIds, getBlockedProfileIds }
