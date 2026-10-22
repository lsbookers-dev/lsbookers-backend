// lib/regions.js — Régions françaises (carrousel régional, newsletter régionale).
// La région d'un profil est déduite de sa ville via geo.api.gouv.fr puis gardée dans Profile.regionCode.
const prisma = require('../prisma/client')

// Codes INSEE des régions (métropole + outre-mer)
const REGIONS = {
  '84': 'Auvergne-Rhône-Alpes',
  '27': 'Bourgogne-Franche-Comté',
  '53': 'Bretagne',
  '24': 'Centre-Val de Loire',
  '94': 'Corse',
  '44': 'Grand Est',
  '32': 'Hauts-de-France',
  '11': 'Île-de-France',
  '28': 'Normandie',
  '75': 'Nouvelle-Aquitaine',
  '76': 'Occitanie',
  '52': 'Pays de la Loire',
  '93': "Provence-Alpes-Côte d'Azur",
  '01': 'Guadeloupe',
  '02': 'Martinique',
  '03': 'Guyane',
  '04': 'La Réunion',
  '06': 'Mayotte',
}

const regionName = (code) => (code && REGIONS[code]) || null

async function fetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Cherche la région d'une commune : d'abord par coordonnées, sinon par code postal, sinon par nom
async function lookupRegionCode({ latitude, longitude, postalCode, city }) {
  const base = 'https://geo.api.gouv.fr/communes'
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const rows = await fetchJson(`${base}?lat=${latitude}&lon=${longitude}&fields=codeRegion&limit=1`)
    if (rows?.[0]?.codeRegion) return rows[0].codeRegion
  }
  if (postalCode && /^\d{5}$/.test(String(postalCode).trim())) {
    const rows = await fetchJson(`${base}?codePostal=${String(postalCode).trim()}&fields=codeRegion&limit=1`)
    if (rows?.[0]?.codeRegion) return rows[0].codeRegion
  }
  const name = String(city || '').split(',')[0].trim()
  if (name) {
    const rows = await fetchJson(`${base}?nom=${encodeURIComponent(name)}&fields=codeRegion&boost=population&limit=1`)
    if (rows?.[0]?.codeRegion) return rows[0].codeRegion
  }
  return null
}

// Profils dont la ville n'a pas donné de région : on ne redemande pas avant une heure
const misses = new Map()
const MISS_TTL_MS = 60 * 60 * 1000

// Région d'un profil (calculée une fois puis mémorisée). Renvoie null si la ville est inconnue.
async function ensureProfileRegion(profileId) {
  const missedAt = misses.get(profileId)
  if (missedAt && Date.now() - missedAt < MISS_TTL_MS) {
    const row = await prisma.profile.findUnique({ where: { id: profileId }, select: { regionCode: true } })
    return row?.regionCode || null
  }
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true, regionCode: true, latitude: true, longitude: true, postalCode: true, city: true, location: true, country: true },
  })
  if (!profile) return null
  if (profile.regionCode) return profile.regionCode
  if (profile.country && !/^france$/i.test(profile.country.trim())) return null
  const code = await lookupRegionCode({
    latitude: profile.latitude, longitude: profile.longitude, postalCode: profile.postalCode,
    city: profile.location || profile.city,
  })
  if (code && REGIONS[code]) {
    await prisma.profile.update({ where: { id: profile.id }, data: { regionCode: code } }).catch(() => {})
    misses.delete(profileId)
    return code
  }
  misses.set(profileId, Date.now())
  return null
}

module.exports = { REGIONS, regionName, lookupRegionCode, ensureProfileRegion }
