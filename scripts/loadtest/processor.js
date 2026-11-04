// scripts/loadtest/processor.js — Petites fonctions du scénario de test de charge (Artillery).
const CITIES = ['Paris', 'Marseille', 'Lyon', 'Toulouse', 'Nice', 'Nantes', 'Bordeaux', 'Lille', 'Montpellier', 'Toulon']
const ROLES = ['ARTIST', 'ORGANIZER', 'PROVIDER', '']
const pick = (a) => a[Math.floor(Math.random() * a.length)]

// Début de visite : un autre membre au hasard, dont on regardera le profil
function authHeader(context, events, done) {
  context.vars.otherId = 1 + Math.floor(Math.random() * 1000)
  done()
}

// Recherche variée : par rôle, ville, ville + rayon (distance calculée par la base)
function randomSearch(context, events, done) {
  const params = new URLSearchParams()
  const role = pick(ROLES)
  if (role) params.set('role', role)
  const r = Math.random()
  if (r < 0.4) { params.set('zone', pick(CITIES)); params.set('radius', String(pick([25, 50, 100]))) }
  else if (r < 0.7) params.set('zone', pick(CITIES).toLowerCase())
  context.vars.searchQuery = params.toString()
  done()
}

// Première conversation de la liste et l'autre participant (destinataire du message)
function pickConversation(req, res, context, events, done) {
  try {
    const conv = JSON.parse(res.body).conversations?.[0]
    if (conv) {
      context.vars.conversationId = conv.id
      const other = conv.participants.find((p) => String(p.id) !== String(context.vars.id))
      if (other) context.vars.recipientId = other.id
    }
  } catch { /* liste vide */ }
  done()
}

function messageBody(req, context, events, done) {
  req.json = { recipientId: Number(context.vars.recipientId), content: `Message du test de charge ${Date.now()}` }
  done()
}

// Chaque demande part connectée avec le jeton du membre virtuel
function addAuth(req, context, events, done) {
  req.headers = { ...(req.headers || {}), Authorization: `Bearer ${context.vars.token}` }
  done()
}

module.exports = { authHeader, randomSearch, pickConversation, messageBody, addAuth }
