const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const authenticate = require('../middleware/authenticate')

// ✅ Correctif : fetch compatible CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))

// ✅ Fonction utilitaire : Haversine
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

// ✅ Route principale de recherche
router.get('/', authenticate, async (req, res) => {
  const { name, role, specialty, typeEtablissement, zone, radius, country } = req.query

  let lat = null
  let lon = null
  let effectiveRadius = radius ? parseFloat(radius) : 50
  let resolvedCountry = country || null

  try {
    // 🌍 Géocodage si zone présente
    if (zone) {
      const geoRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(zone)}`
      )
      const geoData = await geoRes.json()

      if (geoData.length > 0) {
        lat = parseFloat(geoData[0].lat)
        lon = parseFloat(geoData[0].lon)
        if (!resolvedCountry) {
          resolvedCountry = geoData[0]?.address?.country || null
        }
      } else {
        return res.status(400).json({ error: 'Zone géographique introuvable' })
      }
    }

    // 🔍 Recherche générale
    const users = await prisma.user.findMany({
      where: {
        ...(name && {
          name: {
            contains: name,
            mode: 'insensitive'
          }
        }),
        ...(role && { role }),
        profile: {
          ...(specialty && {
            specialties: {
              has: specialty
            }
          }),
          ...(typeEtablissement && {
            typeEtablissement: {
              equals: typeEtablissement
            }
          }),
          ...(resolvedCountry && {
            country: {
              equals: resolvedCountry
            }
          })
        }
      },
      include: {
        profile: true
      },
      orderBy: {
        name: 'asc'
      }
    })

    let finalUsers = users

    if (lat && lon && effectiveRadius) {
      finalUsers = users.filter(user => {
        const p = user.profile
        if (!p?.latitude || !p?.longitude) return false

        const distance = getDistance(lat, lon, p.latitude, p.longitude)

        if (user.role === 'ARTIST' && p.radiusKm) {
          return distance <= effectiveRadius && distance <= p.radiusKm
        }

        return distance <= effectiveRadius
      })
    }

    res.json({ users: finalUsers })
  } catch (err) {
    console.error('❌ Erreur lors de la recherche :', err)
    res.status(500).json({ error: 'Erreur serveur lors de la recherche' })
  }
})

module.exports = router