// lib/stripe.js — Client Stripe. Tant que STRIPE_SECRET_KEY n'est pas renseignée (Railway),
// les paiements sont simplement indisponibles : le reste du site fonctionne normalement.
const Stripe = require('stripe')

let client = null

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  if (!client) client = new Stripe(key, { appInfo: { name: 'LS Bookers' } })
  return client
}

const isLiveMode = () => String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_')

// Adresse du site pour les retours de paiement Stripe
const siteUrl = () => (process.env.APP_URL || 'https://lsbookers.com').replace(/\/+$/, '')

// Réponse standard quand Stripe n'est pas encore configuré
function stripeUnavailable(res) {
  return res.status(503).json({ error: 'PAYMENTS_UNAVAILABLE', message: 'Les paiements en ligne ne sont pas encore ouverts.' })
}

module.exports = { getStripe, isLiveMode, siteUrl, stripeUnavailable }
