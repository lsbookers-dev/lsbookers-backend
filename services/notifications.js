// services/notifications.js — Service centralisé de création de notifications
// Importé par toutes les routes qui déclenchent des actions utilisateur.
// Les erreurs sont silencieuses pour ne jamais bloquer le flux principal.

const prisma = require('../prisma/client')

/**
 * Crée une notification de façon sécurisée.
 * Ne crée pas de notification si actorId === userId (pas d'auto-notif).
 *
 * @param {object} opts
 * @param {number}  opts.userId    — destinataire
 * @param {string}  opts.type     — ex: 'NEW_MESSAGE', 'BOOKING_ACCEPTED', 'NEW_FOLLOW'...
 * @param {string}  opts.content  — texte affiché dans la page /notifications
 * @param {number} [opts.actorId] — utilisateur à l'origine de l'action
 * @param {number} [opts.messageId] — message lié (permet le lien vers la conversation)
 * @param {number} [opts.offerId]   — offre liée (permet le lien vers /offers)
 */
async function createNotif({ userId, type, content, actorId, messageId, offerId } = {}) {
  try {
    if (!userId || !type || !content) return
    // Pas d'auto-notification
    if (actorId && Number(actorId) === Number(userId)) return

    await prisma.notification.create({
      data: {
        userId:    Number(userId),
        type,
        content,
        ...(actorId   != null ? { actorId:   Number(actorId)   } : {}),
        ...(messageId != null ? { messageId: Number(messageId) } : {}),
        ...(offerId   != null ? { offerId:   Number(offerId)   } : {}),
      },
    })
  } catch (err) {
    // Silencieux — ne jamais faire planter le flux principal pour une notif
    console.error(`❌ [createNotif] type=${type} userId=${userId} :`, err.message)
  }
}

/**
 * Utilitaire — retourne le nom d'affichage d'un user Prisma.
 */
function displayName(user) {
  if (!user) return 'Quelqu\'un'
  return user.pseudo || [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Utilisateur'
}

module.exports = { createNotif, displayName }
