// services/notifications.js — Service centralisé de création de notifications
// Importé par toutes les routes qui déclenchent des actions utilisateur.
// Les erreurs sont silencieuses pour ne jamais bloquer le flux principal.

const prisma = require('../prisma/client')
const { resolvePrefs, wantsBell, wantsEmail } = require('../lib/notifPrefs')

// E-mails : mis en attente 10 min puis groupés (services/pendingEmails.js)
const { queueNotificationEmail, queueNotificationEmails } = require('./pendingEmails')

/** Choix du destinataire (cloche / e-mail) ; en cas d'erreur, réglages par défaut */
async function recipientPrefs(userId) {
  try {
    const user = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { email: true, notifPrefs: true } })
    return { email: user?.email || null, prefs: resolvePrefs(user?.notifPrefs) }
  } catch {
    return { email: null, prefs: resolvePrefs(null) }
  }
}

// Gestes qu'on peut défaire puis refaire (J'aime, abonnement…) : une seule notification par personne
// et par publication sur 30 jours. Aimer, ne plus aimer puis aimer à nouveau ne prévient pas deux fois.
const ONCE_TYPES = new Set(['NEW_LIKE', 'NEW_FOLLOW', 'NEW_COMMENT_LIKE', 'TAG_ON_PUBLICATION'])
const ONCE_WINDOW_MS = 30 * 24 * 3600 * 1000

async function alreadyNotified({ userId, type, actorId, publicationId, content }) {
  if (!ONCE_TYPES.has(type) || !actorId) return false
  try {
    const existing = await prisma.notification.findFirst({
      where: {
        userId: Number(userId), type, actorId: Number(actorId),
        publicationId: publicationId != null ? Number(publicationId) : null,
        // J'aime sur un commentaire : le texte cite le commentaire, deux commentaires différents = deux notifications
        ...(type === 'NEW_COMMENT_LIKE' ? { content } : {}),
        createdAt: { gte: new Date(Date.now() - ONCE_WINDOW_MS) },
      },
      select: { id: true },
    })
    return !!existing
  } catch {
    return false
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
 * @param {object} [opts.email]         — e-mail plus précis : { subject, title, rows: [[libellé, valeur]], quote, ctaLabel }
 */
async function createNotif({ userId, type, content, actorId, messageId, offerId, publicationId, deviceToken, staffId, eventId, email: emailDetails } = {}) {
  try {
    if (!userId || !type || !content) return
    // Pas d'auto-notification
    if (actorId && Number(actorId) === Number(userId)) return
    // Déjà prévenu de ce geste récemment (J'aime défait puis refait…) : ni cloche ni e-mail
    if (await alreadyNotified({ userId, type, actorId, publicationId, content })) return

    // Choix du membre (Réglages › Notifications et e-mails)
    const { email, prefs } = await recipientPrefs(userId)
    const sendEmail = !!email && wantsEmail(prefs, type)
    const queue = (notificationId) => sendEmail && queueNotificationEmail({
      userId, type, content, actorId, messageId, offerId, eventId, notificationId, email: emailDetails,
    })
    if (!wantsBell(prefs, type)) { await queue(null); return }

    const notification = await prisma.notification.create({
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
      select: { id: true },
    })
    // E-mail 10 min plus tard, seulement si la notification n'a pas été vue sur le site entre-temps
    await queue(notification?.id)
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
 * Renvoie { bell, email } : nombre de cloches créées et d'e-mails mis en attente.
 */
const NOTIFY_CHUNK = 500
async function notifyMany({ userIds, type, content, actorId, offerId, publicationId, eventId, email: emailDetails } = {}) {
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
      if (u.email && wantsEmail(prefs, type)) emailTo.push(u.id)
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

  // E-mails mis en attente (10 min, groupés avec les autres nouveautés de chaque membre)
  const email = await queueNotificationEmails(emailTo, { type, content, actorId, offerId, eventId, email: emailDetails })
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
