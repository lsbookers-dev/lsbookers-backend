// services/moderation.js — Signalements des membres et décisions de l'admin (16/11/2026)
//
// Choix d'Antho : on peut signaler un profil, une publication, un commentaire ou une offre (D2) ;
// un contenu signalé par plusieurs membres différents est masqué en attendant la décision (E2,
// seuil réglable : planSettings.moderation.autoHideAt, 0 = jamais) ; l'auteur n'est prévenu que
// si l'admin agit, avec le motif et jamais le nom de la personne qui a signalé (F1).

const prisma = require('../prisma/client')
const { getPlanSettings } = require('../lib/planSettings')
const { deleteR2Object } = require('../lib/r2')
const { createNotif } = require('./notifications')
const { notifyAdmins } = require('./adminAlerts')
const { deliverEmail, emailLayout, FROM, APP_URL } = require('../utils/email')

const REASONS = {
  SEXUAL: 'Contenu sexuel ou choquant',
  HARASSMENT: 'Harcèlement ou propos haineux',
  FAKE: 'Faux profil ou usurpation d’identité',
  SCAM: 'Arnaque ou fraude',
  SPAM: 'Spam ou publicité',
  COPYRIGHT: 'Contenu volé (droits d’auteur)',
  OTHER: 'Autre',
}
const TARGET_TYPES = ['PROFILE', 'PUBLICATION', 'COMMENT', 'OFFER']
const ACTIONS = ['DISMISS', 'REMOVE', 'WARN', 'BAN']
const DAILY_LIMIT = 10
const DETAILS_MAX = 500

// Accords : « votre publication a été retirée », « votre commentaire a été retiré »
const WORDS = {
  PROFILE: { le: 'le profil', votre: 'votre profil', e: '' },
  PUBLICATION: { le: 'la publication', votre: 'votre publication', e: 'e' },
  COMMENT: { le: 'le commentaire', votre: 'votre commentaire', e: '' },
  OFFER: { le: 'l’offre', votre: 'votre offre', e: 'e' },
}

class ModerationError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

const userName = (u) => u?.pseudo || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || 'Compte supprimé'
const cut = (text, max) => { const s = String(text || '').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s }
const USER_NAME = { id: true, pseudo: true, firstName: true, lastName: true }

/** Ce qui est signalé : son auteur et une copie du contenu. null si introuvable. */
async function describeTarget(targetType, targetId) {
  if (targetType === 'PROFILE') {
    const user = await prisma.user.findUnique({
      where: { id: targetId },
      select: { ...USER_NAME, role: true, profile: { select: { id: true, avatar: true } } },
    })
    if (!user || String(user.role).toUpperCase() === 'ADMIN') return null
    return { authorId: user.id, snapshot: { name: userName(user), role: user.role, avatar: user.profile?.avatar || null, profileId: user.profile?.id || null } }
  }
  if (targetType === 'PUBLICATION') {
    const pub = await prisma.publication.findUnique({
      where: { id: targetId },
      select: { title: true, caption: true, media: true, mediaType: true, profile: { select: { userId: true } } },
    })
    if (!pub) return null
    return { authorId: pub.profile?.userId || null, snapshot: { title: pub.title, text: cut(pub.caption, 1000), media: pub.media, mediaType: pub.mediaType } }
  }
  if (targetType === 'COMMENT') {
    const comment = await prisma.publicationComment.findUnique({
      where: { id: targetId },
      select: { content: true, publicationId: true, profile: { select: { userId: true } } },
    })
    if (!comment) return null
    return { authorId: comment.profile?.userId || null, snapshot: { text: cut(comment.content, 1000), publicationId: comment.publicationId } }
  }
  if (targetType === 'OFFER') {
    const offer = await prisma.offer.findUnique({
      where: { id: targetId },
      select: { title: true, description: true, location: true, date: true, fee: true, organizer: { select: { userId: true } } },
    })
    if (!offer) return null
    return { authorId: offer.organizer?.userId || null, snapshot: { title: offer.title, text: cut(offer.description, 1000), location: offer.location, date: offer.date, fee: offer.fee } }
  }
  return null
}

/** Masque (ou rend visible) une publication, un commentaire ou une offre. Un profil ne se masque jamais seul. */
async function setHidden(targetType, targetId, hidden) {
  const data = { hiddenAt: hidden ? new Date() : null }
  const where = { id: targetId, hiddenAt: hidden ? null : { not: null } }
  if (targetType === 'PUBLICATION') return (await prisma.publication.updateMany({ where, data })).count
  if (targetType === 'COMMENT') return (await prisma.publicationComment.updateMany({ where, data })).count
  // Une offre retirée par l'admin est fermée : on ne la remet pas en ligne en la « démasquant »
  if (targetType === 'OFFER') return (await prisma.offer.updateMany({ where: { ...where, status: 'ACTIVE' }, data })).count
  return 0
}

async function emailAdmins({ title, text }) {
  try {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN', bannedAt: null }, select: { email: true } })
    const to = admins.map(a => a.email).filter(Boolean)
    if (!to.length) return
    await deliverEmail({
      from: FROM, to,
      subject: `${title} — LS Bookers`,
      html: emailLayout({
        title,
        paragraphs: [text],
        ctaLabel: 'Ouvrir les signalements',
        ctaUrl: `${APP_URL}/admin/signalements`,
        footer: 'E-mail envoyé aux administrateurs de LS Bookers.',
      }),
    })
  } catch (err) {
    console.error('Signalement : e-mail admin non envoyé', err.message)
  }
}

/**
 * Enregistre le signalement d'un membre.
 * Renvoie { ok: true, already, author } (already = ce membre avait déjà signalé ce contenu).
 */
async function createReport({ reporterId, targetType, targetId, reason, details }) {
  if (!TARGET_TYPES.includes(targetType) || !Number.isInteger(targetId) || targetId <= 0) {
    throw new ModerationError(400, 'INVALID', 'Signalement invalide.')
  }
  if (!REASONS[reason]) throw new ModerationError(400, 'REASON', 'Choisissez un motif.')
  const text = cut(details, DETAILS_MAX) || null
  if (reason === 'OTHER' && !text) throw new ModerationError(400, 'DETAILS', 'Précisez le problème en quelques mots.')

  const target = await describeTarget(targetType, targetId)
  if (!target) throw new ModerationError(404, 'NOT_FOUND', 'Ce contenu n’existe plus.')
  if (target.authorId === reporterId) throw new ModerationError(400, 'SELF', 'Vous ne pouvez pas signaler votre propre contenu.')

  // Auteur renvoyé au site pour proposer « Bloquer aussi … » après l'envoi
  const authorUser = target.authorId ? await prisma.user.findUnique({ where: { id: target.authorId }, select: USER_NAME }) : null
  const author = authorUser ? { id: target.authorId, name: userName(authorUser) } : null

  const existing = await prisma.report.findFirst({ where: { reporterId, targetType, targetId }, select: { id: true } })
  if (existing) return { ok: true, already: true, author }

  const today = await prisma.report.count({ where: { reporterId, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } })
  if (today >= DAILY_LIMIT) throw new ModerationError(429, 'LIMIT', 'Vous avez envoyé beaucoup de signalements aujourd’hui. Réessayez demain.')

  try {
    await prisma.report.create({
      data: { reporterId, targetType, targetId, targetUserId: target.authorId, reason, details: text, snapshot: target.snapshot },
    })
  } catch (err) {
    if (err.code === 'P2002') return { ok: true, already: true, author } // double clic
    throw err
  }

  // Masquage automatique + alerte de l'admin (au 1er signalement du contenu, puis quand il est masqué)
  const pending = await prisma.report.count({ where: { targetType, targetId, status: 'PENDING' } })
  const settings = await getPlanSettings()
  const threshold = Number(settings.moderation?.autoHideAt) || 0
  const hiddenNow = threshold > 0 && pending >= threshold && (await setHidden(targetType, targetId, true)) > 0
  if (pending === 1 || hiddenNow) {
    const what = `${WORDS[targetType].le}${target.snapshot.title || target.snapshot.name ? ` « ${cut(target.snapshot.title || target.snapshot.name, 60)} »` : ''}`
    const content = hiddenNow
      ? `Signalé ${pending} fois, ${what} est masqué${WORDS[targetType].e} en attendant votre décision.`
      : `Nouveau signalement : ${what} (${REASONS[reason]}).`
    await notifyAdmins({ type: 'ADMIN_REPORT', content, actorId: reporterId })
    await emailAdmins({ title: hiddenNow ? 'Contenu masqué après plusieurs signalements' : 'Nouveau signalement', text: content })
  }
  return { ok: true, already: false, author }
}

/** Nombre de contenus (pas de signalements) qui attendent une décision */
async function pendingTargetCount() {
  const groups = await prisma.report.groupBy({ by: ['targetType', 'targetId'], where: { status: 'PENDING' } })
  return groups.length
}

const mostCommon = (values) => {
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
}

/** État actuel du contenu signalé (encore en ligne ? masqué ?) */
async function liveState(targetType, targetId) {
  if (targetType === 'PROFILE') {
    const u = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } })
    return { exists: !!u, hidden: false }
  }
  const select = { hiddenAt: true }
  const row = targetType === 'PUBLICATION' ? await prisma.publication.findUnique({ where: { id: targetId }, select })
    : targetType === 'COMMENT' ? await prisma.publicationComment.findUnique({ where: { id: targetId }, select })
      : await prisma.offer.findUnique({ where: { id: targetId }, select: { ...select, status: true } })
  return { exists: !!row && row.status !== 'CLOSED', hidden: !!row?.hiddenAt }
}

/**
 * Liste pour l'admin, regroupée par contenu signalé.
 * status 'pending' : ce qui attend une décision ; 'done' : les décisions déjà prises.
 */
async function listReports(status) {
  const pending = status !== 'done'
  const rows = await prisma.report.findMany({
    where: pending ? { status: 'PENDING' } : { status: { not: 'PENDING' } },
    orderBy: pending ? { createdAt: 'asc' } : { resolvedAt: 'desc' },
    take: pending ? 1000 : 300,
  })

  const groups = new Map()
  for (const r of rows) {
    const key = pending ? `${r.targetType}:${r.targetId}` : `${r.targetType}:${r.targetId}:${r.resolvedAt?.getTime()}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  const userIds = [...new Set(rows.flatMap(r => [r.reporterId, r.targetUserId, r.resolvedById]).filter(Boolean))]
  const users = userIds.length
    ? await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { ...USER_NAME, email: true, role: true, createdAt: true, warningCount: true, bannedAt: true, profile: { select: { id: true, avatar: true } } },
    })
    : []
  const byId = new Map(users.map(u => [u.id, u]))

  // Contenus déjà retirés à chaque auteur (une décision = un contenu)
  const authorIds = [...new Set(rows.map(r => r.targetUserId).filter(Boolean))]
  const removed = authorIds.length
    ? await prisma.report.groupBy({ by: ['targetUserId', 'targetType', 'targetId'], where: { targetUserId: { in: authorIds }, status: 'REMOVED' } })
    : []
  const removedCount = new Map()
  for (const g of removed) removedCount.set(g.targetUserId, (removedCount.get(g.targetUserId) || 0) + 1)

  const out = []
  for (const [key, list] of groups) {
    const first = list[0]
    const last = list.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
    const author = byId.get(first.targetUserId)
    const state = pending ? await liveState(first.targetType, first.targetId) : null
    out.push({
      key,
      targetType: first.targetType,
      targetId: first.targetId,
      count: list.length,
      reason: mostCommon(list.map(r => r.reason)),
      lastAt: last.createdAt,
      snapshot: last.snapshot || null,
      state,
      author: author ? {
        id: author.id, name: userName(author), email: author.email, role: author.role, createdAt: author.createdAt,
        warningCount: author.warningCount, bannedAt: author.bannedAt, avatar: author.profile?.avatar || null,
        profileId: author.profile?.id || null, removedCount: removedCount.get(author.id) || 0,
      } : null,
      reports: list.map(r => ({
        id: r.id, reporter: r.reporterId ? userName(byId.get(r.reporterId)) : 'Compte supprimé',
        reason: r.reason, details: r.details, createdAt: r.createdAt,
      })),
      ...(pending ? {} : {
        status: first.status, resolvedAt: first.resolvedAt, resolutionNote: first.resolutionNote,
        resolvedBy: first.resolvedById ? userName(byId.get(first.resolvedById)) : null,
      }),
    })
  }
  if (pending) out.sort((a, b) => b.count - a.count || new Date(b.lastAt) - new Date(a.lastAt))
  return out
}

/** Retire le contenu du site (fichiers compris pour une publication) */
async function removeTarget(targetType, targetId) {
  if (targetType === 'PUBLICATION') {
    const pub = await prisma.publication.findUnique({ where: { id: targetId }, select: { media: true, additionalMedia: { select: { url: true } } } })
    if (!pub) return
    await Promise.all([deleteR2Object(pub.media), ...pub.additionalMedia.map(m => deleteR2Object(m.url))])
    await prisma.publication.delete({ where: { id: targetId } })
  } else if (targetType === 'COMMENT') {
    await prisma.publicationComment.deleteMany({ where: { id: targetId } })
  } else if (targetType === 'OFFER') {
    // Une offre garde ses candidatures et ses messages : elle est fermée et cachée, pas effacée
    await prisma.offer.updateMany({ where: { id: targetId }, data: { status: 'CLOSED', hiddenAt: new Date() } })
  }
}

async function emailMember(userId, { title, text }) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
    if (!user?.email) return
    await deliverEmail({
      from: FROM, to: user.email,
      subject: `${title} — LS Bookers`,
      html: emailLayout({
        title,
        paragraphs: [text, `Une question ? Écrivez-nous depuis la page <a href="${APP_URL}/contact" style="color:#c4b5fd">Contact</a>.`],
      }),
    })
  } catch (err) {
    console.error('Modération : e-mail au membre non envoyé', err.message)
  }
}

/**
 * Décision de l'admin sur un contenu signalé. Ferme tous les signalements en attente de ce contenu.
 * action : DISMISS (sans suite) | REMOVE (retirer le contenu) | WARN (avertir) | BAN (suspendre le compte)
 * Renvoie { action, targetUserId, label, count, reason } (pour le journal admin).
 */
async function resolveReports({ adminId, targetType, targetId, action, reason, note, warn }) {
  if (!TARGET_TYPES.includes(targetType) || !ACTIONS.includes(action)) throw new ModerationError(400, 'INVALID', 'Décision invalide.')
  if (action === 'REMOVE' && targetType === 'PROFILE') throw new ModerationError(400, 'INVALID', 'Un profil ne se retire pas : avertissez ou suspendez le compte.')

  const reports = await prisma.report.findMany({ where: { targetType, targetId, status: 'PENDING' } })
  if (!reports.length) throw new ModerationError(404, 'NOT_FOUND', 'Ce signalement a déjà été traité.')

  const authorId = reports[0].targetUserId
  const author = authorId ? await prisma.user.findUnique({ where: { id: authorId }, select: { ...USER_NAME, email: true, role: true } }) : null
  const finalReason = REASONS[reason] ? reason : mostCommon(reports.map(r => r.reason))
  const reasonText = REASONS[finalReason].toLowerCase()
  const cleanNote = cut(note, DETAILS_MAX) || null
  const snapshot = reports[reports.length - 1].snapshot || {}
  const w = WORDS[targetType]
  const named = snapshot.title ? ` « ${cut(snapshot.title, 60)} »` : ''
  const needsAuthor = action === 'WARN' || action === 'BAN' || (action === 'REMOVE' && warn)
  if (needsAuthor && !author) throw new ModerationError(400, 'NO_AUTHOR', 'Le compte concerné n’existe plus.')
  if (action === 'BAN' && (authorId === adminId || String(author.role).toUpperCase() === 'ADMIN')) {
    throw new ModerationError(400, 'ADMIN', 'Un compte administrateur ne peut pas être suspendu ici.')
  }

  const addWarning = () => prisma.user.update({ where: { id: authorId }, data: { warningCount: { increment: 1 } } })
  let status
  let authorTitle = null
  let authorText = null

  if (action === 'DISMISS') {
    await setHidden(targetType, targetId, false)
    status = 'DISMISSED'
  } else if (action === 'REMOVE') {
    await removeTarget(targetType, targetId)
    if (warn && author) await addWarning()
    status = 'REMOVED'
    authorTitle = `${w.votre[0].toUpperCase()}${w.votre.slice(1)} a été retiré${w.e}`
    authorText = `${authorTitle.replace(' a été', `${named} a été`)} : ${targetType === 'COMMENT' ? 'il' : 'elle'} ne respecte pas les règles de LS Bookers (${reasonText}).${warn ? ' Un avertissement a été ajouté à votre compte.' : ''}`
  } else if (action === 'WARN') {
    await setHidden(targetType, targetId, false)
    await addWarning()
    status = 'WARNED'
    authorTitle = 'Avertissement de LS Bookers'
    authorText = `Avertissement concernant ${w.votre}${named} : ${reasonText}. Merci de respecter les règles de LS Bookers. En cas de nouveau problème, votre compte peut être suspendu.`
  } else {
    await prisma.user.update({
      where: { id: authorId },
      data: { bannedAt: new Date(), banReason: cut(`${REASONS[finalReason]}${cleanNote ? ` — ${cleanNote}` : ''}`, 300), tokenVersion: { increment: 1 } },
    })
    await setHidden(targetType, targetId, false) // un compte suspendu n'apparaît plus nulle part
    status = 'BANNED'
    authorTitle = 'Votre compte LS Bookers est suspendu'
    authorText = `Votre compte a été suspendu : il ne respecte pas les règles de LS Bookers (${reasonText}).`
  }

  const resolvedAt = new Date()
  await prisma.report.updateMany({
    where: { id: { in: reports.map(r => r.id) } },
    data: { status, resolvedAt, resolvedById: adminId, resolutionNote: cleanNote },
  })

  // L'auteur n'est prévenu que si l'admin agit, sans le nom des personnes qui ont signalé
  if (authorText && author) {
    const text = cleanNote ? `${authorText} Message de l’équipe : ${cleanNote}` : authorText
    if (action !== 'BAN') await createNotif({ userId: authorId, type: 'MODERATION_NOTICE', content: text })
    await emailMember(authorId, { title: authorTitle, text })
  }

  // Les personnes qui ont signalé savent ce qu'il est advenu
  const outcome = status === 'DISMISSED'
    ? `Nous avons examiné ${w.le} que vous avez signalé${w.e} : rien ne va à l’encontre des règles de LS Bookers. Merci de votre vigilance.`
    : status === 'REMOVED' ? `Merci pour votre signalement : ${w.le} a été retiré${w.e}.`
      : status === 'WARNED' ? `Merci pour votre signalement : le membre concerné a reçu un avertissement.`
        : `Merci pour votre signalement : le compte concerné a été suspendu.`
  const reporterIds = [...new Set(reports.map(r => r.reporterId).filter(id => id && id !== authorId))]
  await Promise.all(reporterIds.map(userId => createNotif({ userId, type: 'REPORT_RESOLVED', content: outcome })))

  return {
    action, status, targetUserId: authorId, count: reports.length, reason: finalReason, warned: action === 'WARN' || (action === 'REMOVE' && !!warn),
    label: `${w.le}${named}${author ? ` de ${userName(author)}` : ''}`,
  }
}

module.exports = {
  REASONS, TARGET_TYPES, ACTIONS, DAILY_LIMIT, ModerationError,
  createReport, pendingTargetCount, listReports, resolveReports, setHidden,
}
