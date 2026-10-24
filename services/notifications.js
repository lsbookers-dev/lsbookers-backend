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
    // Pastille de la cloche mise à jour tout de suite sur le site ouvert
    try { require('../socket').getIO().to(`user:${Number(userId)}`).emit('notifications_changed') } catch { /* temps réel indisponible */ }
  } catch (err) {
    // Silencieux — ne jamais faire planter le flux principal pour une notif
    console.error(`❌ [createNotif] type=${type} userId=${userId} :`, err.message)
  }
}

/**
 * Même notification pour beaucoup de membres (ex. nouvelle offre pour les abonnés) :
 * réglages lus en une requête, cloches créées par paquets, e-mails envoyés groupés.
 * À lancer sans attendre (la personne à l'origine de l'action n'attend pas l'envoi).
 * Renvoie { bell, email } : nombre de cloches créées et d'e-mails acceptés.
 */
const NOTIFY_CHUNK = 500
async function notifyMany({ userIds, type, content, actorId, offerId, publicationId, eventId } = {}) {
  const ids = [...new Set((userIds || []).map(Number).filter(id => id && id !== Number(actorId)))]
  if (!ids.length || !type || !content) return { bell: 0, email: 0 }

  const bellIds = []
  const emailTo = []
  for (let i = 0; i < ids.length; i += NOTIFY_CHUNK) {
    const users = await prisma.user.findMany({
      where: { id: { in: ids.slice(i, i + NOTIFY_CHUNK) } },
      select: { id: true, email: true, notifPrefs: true },
    })
    for (const u of users) {
      const prefs = resolvePrefs(u.notifPrefs)
      if (wantsBell(prefs, type)) bellIds.push(u.id)
      if (u.email && wantsEmail(prefs, type)) emailTo.push(u.email)
    }
  }

  for (let i = 0; i < bellIds.length; i += NOTIFY_CHUNK) {
    await prisma.notification.createMany({
      data: bellIds.slice(i, i + NOTIFY_CHUNK).map(userId => ({
        userId,
        type,
        content,
        ...(actorId       != null ? { actorId:       Number(actorId)       } : {}),
        ...(offerId       != null ? { offerId:       Number(offerId)       } : {}),
        ...(publicationId != null ? { publicationId: Number(publicationId) } : {}),
        ...(eventId       != null ? { eventId:       Number(eventId)       } : {}),
      })),
    })
  }
  // Pastille de la cloche mise à jour tout de suite sur les sites ouverts
  try {
    if (bellIds.length) require('../socket').getIO().to(bellIds.map(id => `user:${id}`)).emit('notifications_changed')
  } catch { /* temps réel indisponible */ }

  const email = emailTo.length ? await emails().sendNotificationEmails(emailTo, { content }) : 0
  return { bell: bellIds.length, email }
}

/**
 * Utilitaire — retourne le nom d'affichage d'un user Prisma.
 */
function displayName(user) {
  if (!user) return 'Quelqu\'un'
  return user.pseudo || [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Utilisateur'
}

module.exports = { createNotif, notifyMany, displayName }
