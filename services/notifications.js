// services/notifications.js — Service centralisé de création de notifications
// Importé par toutes les routes qui déclenchent des actions utilisateur.
// Les erreurs sont silencieuses pour ne jamais bloquer le flux principal.

const prisma = require('../prisma/client')
const { resolvePrefs, wantsBell, wantsEmail } = require('../lib/notifPrefs')

// Module e-mail chargé à la demande (il exige la clé Resend, absente des tests)
const emails = () => require('../utils/email')

/** Choix du destinataire (cloche / e-mail) ; en cas d'erreur, réglages par défaut */
async function recipientPrefs(userId) {
  try {
    const user = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { email: true, notifPrefs: true } })
    return { email: user?.email || null, prefs: resolvePrefs(user?.notifPrefs) }
  } catch {
    return { email: null, prefs: resolvePrefs(null) }
  }
}

/**
 * Crée une notification de façon sécurisée.
 * Ne crée pas de notification si actorId === userId (pas d'auto-notif).
 *
 * @param {object} opts
 * @param {number}  opts.userId    — destinataire
 * @param {string}  opts.type     — ex: 'NEW_MESSAGE', 'BOOKING_ACCEPTED', 'NEW_FOLLOW'...
 * @param {string}  opts.content  — texte affiché dans la page /notifications
 * @param {number} [opts.actorId] — utilisateur à l'origine de l'action
 * @param {number} [opts.messageId]     — message lié (permet le lien vers la conversation)
 * @param {number} [opts.offerId]       — offre liée (permet le lien vers /offers)
 * @param {number} [opts.publicationId] — publication liée (permet le lien vers la publication)
 * @param {number} [opts.eventId]       — événement lié (lien direct vers l'agenda)
 */
async function createNotif({ userId, type, content, actorId, messageId, offerId, publicationId, deviceToken, staffId, eventId } = {}) {
  try {
    if (!userId || !type || !content) return
    // Pas d'auto-notification
    if (actorId && Number(actorId) === Number(userId)) return

    // Choix du membre (Réglages › Notifications et e-mails)
    const { email, prefs } = await recipientPrefs(userId)
    if (email && wantsEmail(prefs, type)) {
      // Sans attendre : l'e-mail ne doit jamais ralentir ni bloquer l'action
      emails().sendNotificationEmail(email, { content })
        .catch(err => console.error(`❌ [createNotif] e-mail type=${type} :`, err.message))
    }
    if (!wantsBell(prefs, type)) return

    await prisma.notification.create({
      data: {
        userId:    Number(userId),
        type,
        content,
        ...(actorId       != null ? { actorId:       Number(actorId)       } : {}),
        ...(messageId     != null ? { messageId:     Number(messageId)     } : {}),
        ...(offerId       != null ? { offerId:       Number(offerId)       } : {}),
        ...(publicationId != null ? { publicationId: Number(publicationId) } : {}),
        ...(deviceToken   != null ? { deviceToken                          } : {}),
        ...(staffId       != null ? { staffId:       Number(staffId)       } : {}),
        ...(eventId       != null ? { eventId:       Number(eventId)       } : {}),
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
