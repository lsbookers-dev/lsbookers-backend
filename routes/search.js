// routes/search.js
const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const authenticate = require('../middleware/authenticate')

// ✅ fetch compatible CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))

// ✅ Haversine util
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

/**
 * GET /api/search
 * Auth requis. Recherche d’utilisateurs avec filtres (nom, rôle, spécialité, type, zone, rayon, pays).
 * 🔒 L’utilisateur ADMIN est toujours exclu des résultats.
 */
router.get('/', authenticate, async (req, res) => {
  const { name, role, specialty, typeEtablissement, zone, radius, country } = req.query

  let lat = null
  let lon = null
  const effectiveRadius = radius ? parseFloat(radius) : 50
  let resolvedCountry = country || null

  try {
    // ⛔ Si on essaie de filtrer explicitement sur ADMIN, on renvoie vide
    if (String(role).toUpperCase() === 'ADMIN') {
      return res.json({ users: [] })
    }

    // 🌍 Géocodage si zone fournie
    if (zone) {
      const geoRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(zone)}`
      )
      const geoData = await geoRes.json()

      if (Array.isArray(geoData) && geoData.length > 0) {
        lat = parseFloat(geoData[0].lat)
        lon = parseFloat(geoData[0].lon)
        if (!resolvedCountry) {
          resolvedCountry = geoData[0]?.address?.country || null
        }
      } else {
        return res.status(400).json({ error: 'Zone géographique introuvable' })
      }
    }

    // 🔍 Recherche Prisma — ADMIN exclu par défaut
    const users = await prisma.user.findMany({
      where: {
        // Exclure l'admin dans tous les cas
        role: { not: 'ADMIN' },

        ...(name && {
          name: {
            contains: name,
            mode: 'insensitive',
          },
        }),

        // si role est précisé (et ≠ ADMIN), on filtre dessus
        ...(role && String(role).toUpperCase() !== 'ADMIN' && { role: String(role).toUpperCase() }),

        profile: {
          ...(specialty && {
            specialties: { has: specialty },
          }),
          ...(typeEtablissement && {
            typeEtablissement: { equals: typeEtablissement },
          }),
          ...(resolvedCountry && {
            country: { equals: resolvedCountry },
          }),
        },
      },
      include: {
        profile: true,
      },
      orderBy: { name: 'asc' },
    })

    // 📏 Filtre “zone & rayon” (Haversine) si coordonnées connues
    let finalUsers = users
    if (lat != null && lon != null && !Number.isNaN(effectiveRadius)) {
      finalUsers = users.filter((user) => {
        const p = user.profile
        if (!p?.latitude || !p?.longitude) return false

        const distance = getDistance(lat, lon, p.latitude, p.longitude)

        // ARTIST : respecter aussi son rayon perso s’il existe
        if (user.role === 'ARTIST' && p.radiusKm) {
          return distance <= effectiveRadius && distance <= p.radiusKm
        }
        return distance <= effectiveRadius
      })
    }

    return res.json({ users: finalUsers })
  } catch (err) {
    console.error('❌ Erreur lors de la recherche :', err)
    return res.status(500).json({ error: 'Erreur serveur lors de la recherche' })
  }
})

module.exports = router