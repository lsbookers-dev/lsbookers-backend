const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const { requireAuth } = require('../middleware/auth')

// fetch compatible CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))

// Cache simple en mémoire pour éviter de géocoder 10 fois la même ville
const geoCache = new Map()

function normalizeText(value) {
  return String(value || '').trim().toLowerCase()
}

// Haversine util
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

async function geocodeLocation(query) {
  const normalized = normalizeText(query)
  if (!normalized) return null

  if (geoCache.has(normalized)) {
    return geoCache.get(normalized)
  }

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&q=${encodeURIComponent(
        query
      )}`,
      {
        headers: {
          'User-Agent': 'LSBookers/1.0 (contact: support@lsbookers.com)',
          'Accept-Language': 'fr,en',
        },
      }
    )

    if (!res.ok) {
      console.warn(`⚠️ Nominatim a répondu ${res.status} pour "${query}"`)
      geoCache.set(normalized, null)
      return null
    }

    const data = await res.json()

    if (Array.isArray(data) && data.length > 0) {
      const result = {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
      }
      geoCache.set(normalized, result)
      return result
    }

    geoCache.set(normalized, null)
    return null
  } catch (err) {
    console.warn('⚠️ Géocodage impossible pour :', query)
    geoCache.set(normalized, null)
    return null
  }
}

/**
 * GET /api/search
 * Filtres :
 * - name
 * - role
 * - specialty
 * - typeEtablissement
 * - zone
 * - radius
 * - country
 */
router.get('/', requireAuth, async (req, res) => {
  const { name, role, specialty, typeEtablissement, zone, radius, country } = req.query

  const hasRadiusFilter = radius !== undefined && radius !== null && radius !== ''
  const effectiveRadius = hasRadiusFilter ? parseFloat(radius) : null
  const zoneText = normalizeText(zone)

  try {
    if (String(role || '').toUpperCase() === 'ADMIN') {
      return res.json({ users: [] })
    }

    let searchCoords = null

    if (zoneText && hasRadiusFilter) {
      searchCoords = await geocodeLocation(String(zone))
    }

    const users = await prisma.user.findMany({
      where: {
        role: { not: 'ADMIN' },

        ...(name && {
          name: {
            contains: String(name),
            mode: 'insensitive',
          },
        }),

        ...(role &&
          String(role).toUpperCase() !== 'ADMIN' && {
            role: String(role).toUpperCase(),
          }),

        profile: {
          ...(specialty && {
            specialties: { has: String(specialty) },
          }),

          ...(typeEtablissement && {
            typeEtablissement: {
              equals: String(typeEtablissement),
            },
          }),

          ...(country && {
            country: {
              contains: String(country),
              mode: 'insensitive',
            },
          }),
        },
      },
      include: {
        profile: true,
      },
      orderBy: { name: 'asc' },
    })

    let finalUsers = users

    // Cas 1 : zone seule => recherche texte sur la ville / zone
    if (zoneText && !hasRadiusFilter) {
      finalUsers = users.filter((user) => {
        const p = user.profile
        if (!p?.location) return false
        return normalizeText(p.location).includes(zoneText)
      })

      return res.json({ users: finalUsers })
    }

    // Cas 2 : zone + rayon => distance réelle
    if (zoneText && hasRadiusFilter) {
      if (!searchCoords || Number.isNaN(effectiveRadius)) {
        return res.json({ users: [] })
      }

      const results = []

      for (const user of users) {
        const p = user.profile
        if (!p) continue

        let userLat = p.latitude ?? null
        let userLon = p.longitude ?? null

        // Si le profil n'a pas déjà ses coordonnées, on géocode sa ville
        if ((userLat == null || userLon == null) && p.location) {
          const composedLocation = `${p.location}${p.country ? `, ${p.country}` : ''}`
          const geo = await geocodeLocation(composedLocation)

          if (geo) {
            userLat = geo.lat
            userLon = geo.lon
          }
        }

        if (userLat == null || userLon == null) {
          continue
        }

        const distance = getDistance(searchCoords.lat, searchCoords.lon, userLat, userLon)

        if (distance <= effectiveRadius) {
          results.push(user)
        }
      }

      return res.json({ users: results })
    }

    // Cas 3 : pas de zone
    return res.json({ users: finalUsers })
  } catch (err) {
    console.error('❌ Erreur lors de la recherche :', err)
    return res.status(500).json({ error: 'Erreur serveur lors de la recherche' })
  }
})

module.exports = router