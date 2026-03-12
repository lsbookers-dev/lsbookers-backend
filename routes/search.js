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
 * Auth requis. Recherche d’utilisateurs avec filtres :
 * - nom
 * - rôle
 * - spécialité
 * - typeEtablissement
 * - zone
 * - rayon
 * - pays
 *
 * L’utilisateur ADMIN est toujours exclu des résultats.
 */
router.get('/', authenticate, async (req, res) => {
  const { name, role, specialty, typeEtablissement, zone, radius, country } = req.query

  let lat = null
  let lon = null
  const effectiveRadius = radius ? parseFloat(radius) : 50
  let resolvedCountry = country || null

  try {
    // Si on tente explicitement de chercher ADMIN → vide
    if (String(role || '').toUpperCase() === 'ADMIN') {
      return res.json({ users: [] })
    }

    // Géocodage de la zone si fournie
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
      }
    }

    // Requête Prisma de base
    const users = await prisma.user.findMany({
      where: {
        role: { not: 'ADMIN' },

        ...(name && {
          name: {
            contains: name,
            mode: 'insensitive',
          },
        }),

        ...(role &&
          String(role).toUpperCase() !== 'ADMIN' && {
            role: String(role).toUpperCase(),
          }),

        profile: {
          ...(specialty && {
            specialties: { has: specialty },
          }),

          ...(typeEtablissement && {
            typeEtablissement: {
              equals: typeEtablissement,
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

    // Filtre géographique intelligent
    if (zone) {
      const zoneText = String(zone).trim().toLowerCase()

      finalUsers = users.filter((user) => {
        const p = user.profile
        if (!p) return false

        // 1) Cas idéal : coordonnées présentes
        if (
          lat != null &&
          lon != null &&
          p.latitude != null &&
          p.longitude != null &&
          !Number.isNaN(effectiveRadius)
        ) {
          const distance = getDistance(lat, lon, p.latitude, p.longitude)

          // ARTIST : respecter aussi son rayon perso
          if (user.role === 'ARTIST' && p.radiusKm) {
            return distance <= effectiveRadius && distance <= p.radiusKm
          }

          return distance <= effectiveRadius
        }

        // 2) Fallback texte si pas de coordonnées
        if (p.location && p.location.toLowerCase().includes(zoneText)) {
          return true
        }

        return false
      })
    }

    // Si pas de zone mais pays résolu via frontend / filtre explicite,
    // la requête Prisma a déjà filtré avec `country contains`
    return res.json({ users: finalUsers })
  } catch (err) {
    console.error('❌ Erreur lors de la recherche :', err)
    return res.status(500).json({ error: 'Erreur serveur lors de la recherche' })
  }
})

module.exports = router