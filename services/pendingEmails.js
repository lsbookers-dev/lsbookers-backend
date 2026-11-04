// services/pendingEmails.js — File d'attente des e-mails de notification (04/11/2026)
//
// Une notification qui doit partir par e-mail est mise en attente. Toutes les minutes, pour chaque
// membre dont la plus ancienne attend depuis 10 min :
//   - celles déjà vues sur le site (notification lue ou supprimée) sont abandonnées ;
//   - celles dont le membre ne veut plus l'e-mail (Réglages, désinscription) aussi ;
//   - il reste 1 notification → e-mail détaillé ; plusieurs → un seul e-mail qui les liste.

const prisma = require('../prisma/client')
const { resolvePrefs, wantsEmail } = require('../lib/notifPrefs')
const { typeLabel, ctaLabel, linkFor, unsubscribeLinks } = require('../lib/notificationEmail')

const DELAY_MS = 10 * 60 * 1000
const USERS_PER_RUN = 200
const emails = () => require('../utils/email')

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trim()}…` : text)

/** Contenu d'un e-mail en attente, à partir de la notification et des détails fournis par la route */
async function pendingData({ userId, type, content, actorId, messageId, offerId, eventId, notificationId, email = {} }) {
  let conversationId = null
  let actor = null
  if (messageId) {
    const m = await prisma.message.findUnique({ where: { id: Number(messageId) }, select: { conversationId: true } }).catch(() => null)
    conversationId = m?.conversationId || null
  }
  if (actorId && ['NEW_FOLLOW', 'REVIEW_REPLY'].includes(type)) {
    actor = await prisma.user.findUnique({ where: { id: Number(actorId) }, select: { id: true, role: true } }).catch(() => null)
  }
  const label = typeLabel(type)
  const details = email.rows || email.quote ? { rows: email.rows || [], quote: email.quote || null } : null
  return {
    userId: Number(userId),
    type,
    subject: clip(email.subject || `${label} · ${content}`, 120),
    title: email.title || content,
    content,
    link: linkFor({ type, conversationId, offerId, eventId, actor }),
    ctaLabel: email.ctaLabel || ctaLabel(type),
    ...(details ? { details } : {}),
    ...(notificationId ? { notificationId: Number(notificationId) } : {}),
  }
}

/** Met un e-mail de notification en attente (jamais bloquant) */
async function queueNotificationEmail(opts) {
  try {
    await prisma.pendingEmail.create({ data: await pendingData(opts) })
  } catch (err) {
    console.error(`❌ [queueNotificationEmail] type=${opts?.type} :`, err.message)
  }
}

/** Même e-mail pour beaucoup de membres (nouvelle offre pour les abonnés) */
async function queueNotificationEmails(userIds, opts) {
  if (!userIds.length) return 0
  try {
    const base = await pendingData({ ...opts, userId: userIds[0] })
    const { count } = await prisma.pendingEmail.createMany({ data: userIds.map(userId => ({ ...base, userId: Number(userId) })) })
    return count
  } catch (err) {
    console.error(`❌ [queueNotificationEmails] type=${opts?.type} :`, err.message)
    return 0
  }
}

/** Tâche planifiée (toutes les minutes) : envoie ce qui attend depuis 10 min. Renvoie le nombre d'e-mails partis. */
async function sendPendingEmails(now = new Date()) {
  const due = await prisma.pendingEmail.groupBy({
    by: ['userId'],
    where: { createdAt: { lte: new Date(now.getTime() - DELAY_MS) } },
    _min: { createdAt: true },
    orderBy: { _min: { createdAt: 'asc' } },
    take: USERS_PER_RUN,
  })
  if (!due.length) return 0

  const payloads = []
  for (const { userId } of due) {
    const pending = await prisma.pendingEmail.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
    // Pris en charge par ce passage : supprimés tout de suite pour ne jamais partir deux fois
    const { count } = await prisma.pendingEmail.deleteMany({ where: { id: { in: pending.map(p => p.id) } } })
    if (count !== pending.length) continue

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true, notifPrefs: true } })
    if (!user?.email || !user.emailVerified) continue
    const prefs = resolvePrefs(user.notifPrefs)

    // Déjà vue sur le site (lue ou supprimée) : pas d'e-mail
    const notifIds = pending.map(p => p.notificationId).filter(Boolean)
    const stillUnread = new Set(notifIds.length
      ? (await prisma.notification.findMany({ where: { id: { in: notifIds }, read: false }, select: { id: true } })).map(n => n.id)
      : [])
    const items = pending
      .filter(p => !p.notificationId || stillUnread.has(p.notificationId))
      .filter(p => wantsEmail(prefs, p.type))
      .map(p => ({ ...p, label: typeLabel(p.type) }))
    if (!items.length) continue

    payloads.push(emails().buildNotificationEmail(user.email, items, unsubscribeLinks(userId, items.map(i => i.type))))
  }
  return payloads.length ? emails().sendPreparedEmails(payloads) : 0
}

module.exports = { queueNotificationEmail, queueNotificationEmails, sendPendingEmails, pendingData, DELAY_MS }
