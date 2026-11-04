// lib/notificationEmail.js — Contenu des e-mails de notification (04/11/2026)
//
// Objet précis, bouton qui mène au bon endroit (mêmes règles que la cloche du site,
// frontend/src/utils/notificationLinks.ts), lien de désinscription par sujet.

const jwt = require('jsonwebtoken')
const { CATEGORIES, categoryOf } = require('./notifPrefs')

const APP_URL = (process.env.APP_URL || 'https://lsbookers.com').replace(/\/+$/, '')
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || 'https://api.lsbookers.com').replace(/\/+$/, '')

const TYPE_LABEL = {
  BOOKING_REQUEST: 'Proposition de booking',
  BOOKING_APPROVAL_NEEDED: 'Booking à confirmer',
  BOOKING_ACCEPTED: 'Booking accepté',
  BOOKING_DECLINED: 'Booking refusé',
  BOOKING_CANCELLED: 'Booking annulé',
  CANCELLATION_REQUEST: 'Demande d’annulation',
  CANCELLATION_ACCEPTED: 'Annulation confirmée',
  CANCELLATION_DECLINED: 'Annulation refusée',
  BOOKING_ITEM_ADDED: 'Booking mis à jour',
  PAYMENT_RECEIVED: 'Paiement reçu',
  BOOKING_PAYMENT: 'Paiement en ligne',
  BOOKING_PAYMENT_FAILED: 'Paiement refusé',
  PAYOUT_RELEASED: 'Versement',
  LATE_CANCEL_WARNING: 'Annulations tardives',
  NEW_OFFER: 'Nouvelle offre',
  NEW_APPLICATION: 'Nouvelle candidature',
  OFFER_CLOSED: 'Offre pourvue',
  OFFER_TO_CLOSE: 'Offre à clôturer',
  OFFER_FILLED: 'Booking confirmé',
  STAFF_INVITATION: 'Invitation dans une équipe',
  STAFF_ACCEPTED: 'Invitation acceptée',
  STAFF_REFUSED: 'Invitation refusée',
  CHECKLIST_REMINDER: 'Rappel de checklist',
  NEW_REVIEW: 'Nouvel avis',
  REVIEW_AVAILABLE: 'Avis à laisser',
  REVIEW_REPLY: 'Réponse à votre avis',
  NEW_FOLLOW: 'Nouvel abonné',
  NEW_LIKE: 'J’aime',
  NEW_COMMENT: 'Nouveau commentaire',
  NEW_COMMENT_REPLY: 'Réponse à votre commentaire',
  NEW_COMMENT_LIKE: 'J’aime',
  TAG_ON_PUBLICATION: 'Identification',
  MANAGEMENT_INVITE: 'Invitation d’une agence',
  MANAGEMENT_ACCEPTED: 'Gestion acceptée',
  MANAGEMENT_DECLINED: 'Gestion refusée',
  MANAGEMENT_ENDED: 'Fin de gestion',
  PRO_PAUSED_BY_MANAGER: 'Abonnement Pro',
  SUBSCRIPTION_UPDATE: 'Abonnement',
  EXTRA_ORDER_UPDATE: 'Votre commande',
}

const CTA_LABEL = {
  BOOKING_REQUEST: 'Voir la demande',
  BOOKING_APPROVAL_NEEDED: 'Voir la demande',
  CANCELLATION_REQUEST: 'Répondre',
  NEW_OFFER: 'Voir l’offre',
  NEW_APPLICATION: 'Voir la candidature',
  OFFER_TO_CLOSE: 'Clôturer l’offre',
  STAFF_INVITATION: 'Répondre à l’invitation',
  NEW_REVIEW: 'Lire l’avis',
  REVIEW_AVAILABLE: 'Laisser un avis',
  BOOKING_PAYMENT_FAILED: 'Voir le paiement',
  MANAGEMENT_INVITE: 'Répondre à l’invitation',
  NEW_FOLLOW: 'Voir son profil',
}

const typeLabel = (type) => TYPE_LABEL[type] || 'Du nouveau'
const ctaLabel = (type) => CTA_LABEL[type] || 'Voir sur LS Bookers'

const CONVERSATION_TYPES = ['BOOKING_REQUEST', 'BOOKING_APPROVAL_NEEDED', 'BOOKING_ACCEPTED', 'BOOKING_DECLINED',
  'BOOKING_CANCELLED', 'CANCELLATION_REQUEST', 'CANCELLATION_ACCEPTED', 'CANCELLATION_DECLINED', 'PAYMENT_RECEIVED']
const OFFER_TYPES = ['NEW_OFFER', 'NEW_APPLICATION', 'OFFER_CLOSED', 'OFFER_TO_CLOSE']
const EVENT_TYPES = ['STAFF_INVITATION', 'STAFF_ACCEPTED', 'STAFF_REFUSED']
const PAYMENT_TYPES = ['BOOKING_PAYMENT', 'BOOKING_PAYMENT_FAILED', 'PAYOUT_RELEASED']
const PROFILE_PATH = { ARTIST: 'artist', ORGANIZER: 'organizer', PROVIDER: 'provider' }

/** Adresse (sur le site) où mène l'e-mail d'une notification */
function linkFor({ type, conversationId, offerId, eventId, actor }) {
  const agenda = (tab) => (eventId ? `/agenda?event=${eventId}${tab ? `&tab=${tab}` : ''}` : '/agenda')
  let path = '/notifications'
  if (CONVERSATION_TYPES.includes(type)) path = conversationId ? `/messages?c=${conversationId}` : '/agenda'
  else if (OFFER_TYPES.includes(type)) path = offerId ? `/offers?offer=${offerId}` : '/offers'
  else if (['BOOKING_ITEM_ADDED', 'OFFER_FILLED'].includes(type)) path = agenda('bookings')
  else if (type === 'CHECKLIST_REMINDER') path = agenda('checklist')
  else if (EVENT_TYPES.includes(type)) path = agenda()
  else if (PAYMENT_TYPES.includes(type) && eventId) path = agenda('bookings')
  else if (['PAYOUT_RELEASED', 'LATE_CANCEL_WARNING'].includes(type)) path = '/settings/subscription'
  else if (PAYMENT_TYPES.includes(type)) path = '/agenda'
  else if (type === 'NEW_REVIEW' || type === 'REVIEW_AVAILABLE') path = '/space#avis'
  else if (['MANAGEMENT_ACCEPTED', 'MANAGEMENT_DECLINED'].includes(type)) path = '/gestion'
  else if (type.startsWith('MANAGEMENT_') || type === 'PRO_PAUSED_BY_MANAGER') path = '/settings/management'
  else if (type === 'SUBSCRIPTION_UPDATE' || type === 'EXTRA_ORDER_UPDATE') path = '/subscriptions'
  else if (['NEW_FOLLOW', 'REVIEW_REPLY'].includes(type) && actor?.id && PROFILE_PATH[actor.role]) path = `/${PROFILE_PATH[actor.role]}/${actor.id}`
  return `${APP_URL}${path}`
}

/* ── Désinscription en un clic ─────────────────────────────────────────── */

const categoryLabel = (key) => CATEGORIES[key]?.label || key

/** Jeton sans date de fin : il ne fait qu'arrêter des e-mails, jamais autre chose */
function unsubscribeToken(userId, categories) {
  return jwt.sign({ uid: Number(userId), cats: [...new Set(categories)].filter(Boolean), purpose: 'unsubscribe' }, process.env.JWT_SECRET)
}

function readUnsubscribeToken(token) {
  try {
    const p = jwt.verify(String(token || ''), process.env.JWT_SECRET)
    if (p?.purpose !== 'unsubscribe' || !p.uid || !Array.isArray(p.cats)) return null
    const cats = p.cats.filter(c => CATEGORIES[c])
    return cats.length ? { userId: Number(p.uid), categories: cats } : null
  } catch {
    return null
  }
}

/** Liens de désinscription d'un e-mail : page du site (pied de l'e-mail) et appel direct (Gmail, Yahoo) */
function unsubscribeLinks(userId, types) {
  const categories = [...new Set(types.map(categoryOf).filter(Boolean))]
  if (!categories.length) return null
  const token = unsubscribeToken(userId, categories)
  return {
    categories,
    label: categories.length === 1 ? `Ne plus recevoir les e-mails « ${categoryLabel(categories[0])} »` : 'Ne plus recevoir ces e-mails',
    pageUrl: `${APP_URL}/desinscription?token=${encodeURIComponent(token)}`,
    oneClickUrl: `${API_PUBLIC_URL}/api/email/unsubscribe?token=${encodeURIComponent(token)}`,
  }
}

module.exports = { typeLabel, ctaLabel, linkFor, categoryLabel, unsubscribeToken, readUnsubscribeToken, unsubscribeLinks, APP_URL }
