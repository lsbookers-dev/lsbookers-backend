// lib/planSettings.js — Réglages « Offres et abonnements » (commissions, limites, prix, carrousel).
// Valeurs par défaut validées avec Antho (21-22/10/2026) ; l'admin peut tout changer
// (AdminSettings.planSettings ne garde que ce qui a été modifié).
const prisma = require('../prisma/client')

const DEFAULT_PLAN_SETTINGS = {
  // Commission LS Bookers sur un booking payé en ligne, retirée de ce que touche la personne bookée
  commission: { freePct: 10, proPct: 5 },
  // Paiement des bookings : part acquise (bloquée) dès le paiement, débit anticipé, délais
  bookingPayment: { depositPct: 30, chargeDaysBefore: 60, releaseHoursAfter: 24, lateCancelDays: 7 },
  // Limites du compte gratuit
  limits: {
    applicationsPerMonth: 3,     // candidatures aux offres
    bookingRequestsPerMonth: 3,  // demandes de booking envoyées
    activeEvents: 3,             // événements créés soi-même, en cours ou à venir
    activeOffers: 1,             // offres publiées en même temps
    albums: 3,
    videos: 5,                   // vidéos dans les publications
    videoMaxSeconds: 60,
  },
  // Abonnement Pro (prix TTC en centimes) et essai
  prices: {
    ARTIST:    { monthCents: 1199, yearCents: 11999 },
    PROVIDER:  { monthCents: 1199, yearCents: 11999 },
    ORGANIZER: { monthCents: 1199, yearCents: 11999 }, // même tarif pour tous (choix d'Antho, 22/10/2026)
  },
  trialDays: 0, // pas d'essai (choix d'Antho, 22/10/2026) : seuls les codes de lancement offrent des mois
  // Carrousel de l'accueil : places payantes en même temps
  carousel: { regionalSlots: 12, nationalSlots: 10 },
  // Annulations tardives de la personne bookée : avertissement puis alerte admin (bannissement validé à la main)
  lateCancellations: { warnAt: 2, alertAt: 3, windowDays: 365 },
}

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v)

function deepMerge(base, extra) {
  if (!isPlainObject(extra)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    if (!(key in base)) continue // on ignore les clés inconnues
    out[key] = isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

let cache = null
let cacheAt = 0
const TTL_MS = 60 * 1000

async function getPlanSettings() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache
  let stored = null
  try {
    const row = await prisma.adminSettings.findUnique({ where: { id: 1 }, select: { planSettings: true } })
    stored = row?.planSettings || null
  } catch (err) {
    console.warn('planSettings : lecture impossible, valeurs par défaut utilisées', err.code || err.message)
  }
  cache = deepMerge(DEFAULT_PLAN_SETTINGS, stored)
  cacheAt = Date.now()
  return cache
}

function clearPlanSettingsCache() { cache = null; cacheAt = 0 }

module.exports = { DEFAULT_PLAN_SETTINGS, getPlanSettings, clearPlanSettingsCache, deepMerge }
