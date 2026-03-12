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

  let lat = null
  let lon = null
  const hasRadiusFilter = radius !== undefined && radius !== null && radius !== ''
  const effectiveRadius = hasRadiusFilter ? parseFloat(radius) : null

  try {
    if (String(role || '').toUpperCase() === 'ADMIN') {
      return res.json({ users: [] })
    }

    // Géocodage seulement si zone fournie
    if (zone) {
      try {
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(zone)}`
        )
        const geoData = await geoRes.json()

        if (Array.isArray(geoData) && geoData.length > 0) {
          lat = parseFloat(geoData[0].lat)
          lon = parseFloat(geoData[0].lon)
        }
      } catch (geoErr) {
        console.warn('⚠️ Géocodage impossible, fallback texte utilisé')
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

    // Si zone fournie
    if (zone) {
      const zoneText = String(zone).trim().toLowerCase()

      finalUsers = users.filter((user) => {
        const p = user.profile
        if (!p) return false

        const textMatch =
          !!p.location && p.location.toLowerCase().includes(zoneText)

        // Si aucun rayon n’est demandé :
        // on privilégie la recherche textuelle simple par ville / zone
        if (!hasRadiusFilter) {
          return textMatch
        }

        // Si rayon demandé, on essaie le calcul GPS
        if (
          lat != null &&
          lon != null &&
          p.latitude != null &&
          p.longitude != null &&
          !Number.isNaN(effectiveRadius)
        ) {
          const distance = getDistance(lat, lon, p.latitude, p.longitude)

          if (user.role === 'ARTIST' && p.radiusKm) {
            return distance <= effectiveRadius && distance <= p.radiusKm
          }

          return distance <= effectiveRadius
        }

        // Fallback texte si GPS absent
        return textMatch
      })
    }

    return res.json({ users: finalUsers })
  } catch (err) {
    console.error('❌ Erreur lors de la recherche :', err)
    return res.status(500).json({ error: 'Erreur serveur lors de la recherche' })
  }
})

module.exports = router