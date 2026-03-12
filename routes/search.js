const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const authenticate = require('../middleware/authenticate')

// fetch compatible CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))

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

// Géocodage simple d’une localisation texte
async function geocodeLocation(query) {
  if (!query || !String(query).trim()) return null

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(
        query
      )}`
    )
    const data = await res.json()

    if (Array.isArray(data) && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
      }
    }

    return null
  } catch (err) {
    console.warn('⚠️ Géocodage impossible pour :', query)
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
router.get('/', authenticate, async (req, res) => {
  const { name, role, specialty, typeEtablissement, zone, radius, country } = req.query

  let searchLat = null
  let searchLon = null
  const hasRadiusFilter = radius !== undefined && radius !== null && radius !== ''
  const effectiveRadius = hasRadiusFilter ? parseFloat(radius) : null

  try {
    if (String(role || '').toUpperCase() === 'ADMIN') {
      return res.json({ users: [] })
    }

    // Géocoder la zone recherchée
    if (zone) {
      const geo = await geocodeLocation(String(zone))
      if (geo) {
        searchLat = geo.lat
        searchLon = geo.lon
      }
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

    if (zone) {
      const zoneText = String(zone).trim().toLowerCase()

      if (!hasRadiusFilter) {
        // Recherche ville simple = match texte sur location
        finalUsers = users.filter((user) => {
          const p = user.profile
          if (!p?.location) return false
          return p.location.toLowerCase().includes(zoneText)
        })
      } else {
        // Recherche ville + rayon = distance réelle
        const results = []

        for (const user of users) {
          const p = user.profile
          if (!p) continue

          let userLat = p.latitude ?? null
          let userLon = p.longitude ?? null

          // Si pas de coordonnées, on tente un géocodage à la volée
          if (
            (userLat == null || userLon == null) &&
            p.location
          ) {
            const geo = await geocodeLocation(
              `${p.location}${p.country ? `, ${p.country}` : ''}`
            )

            if (geo) {
              userLat = geo.lat
              userLon = geo.lon
            }
          }

          // Si malgré tout on n'a pas de coords → on ignore pour le rayon
          if (
            searchLat == null ||
            searchLon == null ||
            userLat == null ||
            userLon == null ||
            Number.isNaN(effectiveRadius)
          ) {
            continue
          }

          const distance = getDistance(searchLat, searchLon, userLat, userLon)

          if (user.role === 'ARTIST' && p.radiusKm) {
            if (distance <= effectiveRadius && distance <= p.radiusKm) {
              results.push(user)
            }
          } else {
            if (distance <= effectiveRadius) {
              results.push(user)
            }
          }
        }

        finalUsers = results
      }
    }

    return res.json({ users: finalUsers })
  } catch (err) {
    console.error('❌ Erreur lors de la recherche :', err)
    return res.status(500).json({ error: 'Erreur serveur lors de la recherche' })
  }
})

module.exports = router