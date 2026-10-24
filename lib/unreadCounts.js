// lib/unreadCounts.js — Pastilles du site : messages non lus (enveloppe) et notifications non lues (cloche).
const prisma = require('../prisma/client')

// Les messages ne passent jamais par la cloche : seule la pastille de l'enveloppe les signale
// (anciennes notifications NEW_MESSAGE ignorées).
const NOT_MESSAGE = { NOT: { type: 'NEW_MESSAGE' } }

// Messages reçus non lus, hors conversations mises en sourdine (une seule requête)
function countUnreadMessages(userId) {
  return prisma.message.count({
    where: {
      seen: false,
      senderId: { not: userId },
      conversation: { participants: { some: { userId, muted: false } } },
    },
  })
}

function countUnreadNotifications(userId) {
  return prisma.notification.count({ where: { userId, read: false, ...NOT_MESSAGE } })
}

module.exports = { NOT_MESSAGE, countUnreadMessages, countUnreadNotifications }
