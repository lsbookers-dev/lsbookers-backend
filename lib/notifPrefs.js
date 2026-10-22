// lib/notifPrefs.js — Choix de notifications de chaque membre (Réglages › Notifications et e-mails)
//
// Les types de notification sont regroupés en catégories. Pour chacune, le membre choisit
// la cloche (bell) et/ou l'e-mail. Les alertes de sécurité ne se désactivent pas dans la cloche.

const CATEGORIES = {
  bookings: {
    label: 'Bookings',
    types: ['BOOKING_REQUEST', 'BOOKING_ACCEPTED', 'BOOKING_DECLINED', 'BOOKING_CANCELLED', 'CANCELLATION_REQUEST',
      'CANCELLATION_ACCEPTED', 'CANCELLATION_DECLINED', 'BOOKING_ITEM_ADDED', 'PAYMENT_RECEIVED',
      // Paiement en ligne des bookings (Stripe)
      'BOOKING_PAYMENT', 'BOOKING_PAYMENT_FAILED', 'PAYOUT_RELEASED', 'LATE_CANCEL_WARNING'],
    defaults: { bell: true, email: true },
  },
  // Les messages ne passent jamais par la cloche (pastille de « Messages ») : e-mail seulement
  messages: { label: 'Messages', types: [], defaults: { bell: false, email: true }, emailOnly: true },
  offers: { label: 'Offres', types: ['NEW_OFFER', 'NEW_APPLICATION', 'OFFER_CLOSED', 'OFFER_TO_CLOSE'], defaults: { bell: true, email: true } },
  events: { label: 'Événements', types: ['STAFF_INVITATION', 'STAFF_ACCEPTED', 'STAFF_REFUSED', 'CHECKLIST_REMINDER'], defaults: { bell: true, email: true } },
  reviews: { label: 'Avis', types: ['NEW_REVIEW', 'REVIEW_AVAILABLE', 'REVIEW_REPLY'], defaults: { bell: true, email: false } },
  network: {
    label: 'Réseau',
    types: ['NEW_FOLLOW', 'NEW_LIKE', 'NEW_COMMENT', 'NEW_COMMENT_REPLY', 'NEW_COMMENT_LIKE', 'TAG_ON_PUBLICATION'],
    defaults: { bell: true, email: false },
  },
}

// Toujours dans la cloche, quel que soit le choix (l'e-mail dépend de « Alerte de nouvelle connexion »)
const ALWAYS_BELL = new Set(['NEW_DEVICE_LOGIN'])

const categoryOf = (type) => Object.keys(CATEGORIES).find(key => CATEGORIES[key].types.includes(type)) || null

/** Choix complets du membre : ses réglages enregistrés, complétés par les valeurs par défaut */
function resolvePrefs(saved) {
  const out = {}
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const s = saved && typeof saved === 'object' ? saved[key] : null
    out[key] = {
      bell: cat.emailOnly ? false : (typeof s?.bell === 'boolean' ? s.bell : cat.defaults.bell),
      email: typeof s?.email === 'boolean' ? s.email : cat.defaults.email,
    }
  }
  return out
}

/** Nettoie des choix envoyés par le site (catégories et booléens connus uniquement) */
function sanitizePrefs(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const v = input[key]
    if (!v || typeof v !== 'object') continue
    out[key] = {}
    if (typeof v.bell === 'boolean' && !cat.emailOnly) out[key].bell = v.bell
    if (typeof v.email === 'boolean') out[key].email = v.email
  }
  return out
}

function wantsBell(prefs, type) {
  if (ALWAYS_BELL.has(type)) return true
  const key = categoryOf(type)
  return key ? prefs[key].bell : true
}

function wantsEmail(prefs, type) {
  const key = categoryOf(type)
  return key ? prefs[key].email : false
}

module.exports = { CATEGORIES, resolvePrefs, sanitizePrefs, wantsBell, wantsEmail, categoryOf }
