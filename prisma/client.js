// backend/prisma/client.js
// Connexions à la base (#281) : nombre fixé par nous, et non deviné d'après la machine Railway
// (Prisma prend « 2 × processeurs + 1 », qui change d'une machine à l'autre). La base en accepte 500.
//   DB_POOL_SIZE    — connexions ouvertes au maximum par ce serveur (défaut 20)
//   DB_POOL_TIMEOUT — secondes d'attente d'une connexion libre avant erreur (défaut 10)
//   DB_SLOW_QUERY_MS — requêtes plus lentes signalées dans les journaux (défaut 500 ms)
const { PrismaClient } = require('@prisma/client')

const POOL_SIZE = Number(process.env.DB_POOL_SIZE) || 20
const POOL_TIMEOUT = Number(process.env.DB_POOL_TIMEOUT) || 10
const SLOW_QUERY_MS = Number(process.env.DB_SLOW_QUERY_MS) || 500

/** Adresse de la base complétée par les réglages de connexion (ceux déjà présents sont gardés) */
function withPoolSettings(rawUrl) {
  if (!rawUrl) return rawUrl
  try {
    const url = new URL(rawUrl)
    if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', String(POOL_SIZE))
    if (!url.searchParams.has('pool_timeout')) url.searchParams.set('pool_timeout', String(POOL_TIMEOUT))
    return url.toString()
  } catch {
    return rawUrl
  }
}

const prisma = new PrismaClient({
  datasources: { db: { url: withPoolSettings(process.env.DATABASE_URL) } },
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'stdout', level: 'warn' },
    { emit: 'stdout', level: 'error' },
  ],
})

// Requêtes lentes : signalées (sans les valeurs, qui peuvent contenir des données personnelles)
prisma.$on('query', (e) => {
  if (e.duration >= SLOW_QUERY_MS) {
    console.warn(`🐢 Requête lente (${e.duration} ms) : ${String(e.query).slice(0, 300)}`)
  }
})

module.exports = prisma
module.exports.withPoolSettings = withPoolSettings
