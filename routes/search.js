const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')

// fetch compatible CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))

// Cache simple en mémoire pour éviter de géocoder 10 fois la même ville
const geoCache = new Map()

function normalizeText(value) {
  return String(value || '').trim().toLowerCase()
}

function buildPublicNameFilter(value) {
  const query = String(value || '').trim()
  if (!query) return undefined

  return {
    OR: [
      { pseudo: { contains: query, mode: 'insensitive' } },
      {
        AND: [
          { profile: { is: { showRealName: true } } },
          {
            OR: [
              { firstName: { contains: query, mode: 'insensitive' } },
              { lastName: { contains: query, mode: 'insensitive' } },
            ],
          },
        ],
      },
    ],
  }
}

const publicSearchSelect = {
  id: true,
  pseudo: true,
  firstName: true,
  lastName: true,
  role: true,
  createdAt: true,
  profile: {
    select: {
      location: true,
      country: true,
      specialties: true,
      styles: true,
      typeEtablissement: true,
      avatar: true,
      showRealName: true,
      // Utilisées uniquement côté serveur pour le filtre de distance.
      latitude: true,
      longitude: true,
    },
  },
}

function toPublicSearchUser(user) {
  const profile = user.profile
  const showRealName = profile?.showRealName === true

  return {
    id: user.id,
    pseudo: showRealName ? null : user.pseudo,
    firstName: showRealName ? user.firstName : null,
    lastName: showRealName ? user.lastName : null,
    role: user.role,
    createdAt: user.createdAt,
    profile: profile
      ? {
          location: profile.location,
          country: profile.country,
          specialties: profile.specialties,
          styles: profile.styles,
          typeEtablissement: profile.typeEtablissement,
          avatar: profile.avatar,
        }
      : null,
  }
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
  const { name, role, specialty, typeEtablissement, zone, radius, country, date } = req.query

  const hasRadiusFilter = radius !== undefined && radius !== null && radius !== ''
  const effectiveRadius = hasRadiusFilter ? parseFloat(radius) : null
  const zoneText = normalizeText(zone)

  // Filtre disponibilité par date
  let dateStart = null
  let dateEnd = null
  if (date) {
    dateStart = new Date(date)
    dateStart.setUTCHours(0, 0, 0, 0)
    dateEnd = new Date(date)
    dateEnd.setUTCHours(23, 59, 59, 999)
  }

  try {
    if (String(role || '').toUpperCase() === 'ADMIN') {
      return res.json({ users: [] })
    }

    let searchCoords = null

    if (zoneText && hasRadiusFilter) {
      searchCoords = await geocodeLocation(String(zone))
    }

    // IDs bloqués dans les deux sens (moi→eux et eux→moi)
    const blocks = await prisma.block.findMany({
      where: {
        OR: [{ blockerId: req.user.id }, { blockedId: req.user.id }],
      },
      select: { blockerId: true, blockedId: true },
    })
    const blockedIds = blocks.map(b =>
      b.blockerId === req.user.id ? b.blockedId : b.blockerId
    )

    const users = await prisma.user.findMany({
      where: {
        role: { not: 'ADMIN' },
        emailVerified: true,
        id: { not: req.user.id, notIn: blockedIds.length ? blockedIds : undefined },

        ...(name && buildPublicNameFilter(name)),

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

          // Exclure les profils BOOKED ou UNAVAILABLE à la date demandée
          ...(dateStart && dateEnd && {
            availability: {
              none: {
                date: { gte: dateStart, lte: dateEnd },
                status: { in: ['BOOKED', 'UNAVAILABLE'] },
              },
            },
          }),
        },
      },
      select: publicSearchSelect,
      orderBy: { createdAt: 'desc' },
    })

    let finalUsers = users

    // Cas 1 : zone seule => recherche texte sur la ville / zone
    if (zoneText && !hasRadiusFilter) {
      finalUsers = users.filter((user) => {
        const p = user.profile
        if (!p?.location) return false
        return normalizeText(p.location).includes(zoneText)
      })

      return res.json({ users: finalUsers.map(toPublicSearchUser) })
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

      return res.json({ users: results.map(toPublicSearchUser) })
    }

    // Cas 3 : pas de zone
    return res.json({ users: finalUsers.map(toPublicSearchUser) })
  } catch (err) {
    console.error('❌ Erreur lors de la recherche :', err)
    return res.status(500).json({ error: 'Erreur serveur lors de la recherche' })
  }
})

// GET /api/search/users?q=...&limit=8 — recherche rapide d'utilisateurs pour le système de tags
router.get('/users', requireAuth, async (req, res) => {
  const q     = String(req.query.q || '').trim()
  const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20)

  if (!q || q.length < 2) return res.json({ users: [] })

  try {
    const users = await prisma.user.findMany({
      where: {
        id:       { not: req.user.id },
        isAdmin:  false,
        emailVerified: true,
        ...buildPublicNameFilter(q),
      },
      select: {
        id: true,
        pseudo: true,
        firstName: true,
        lastName: true,
        role: true,
        profile: { select: { id: true, avatar: true, showRealName: true } },
      },
      take: limit,
    })
    return res.json({
      users: users.map((user) => {
        const showRealName = user.profile?.showRealName === true
        return {
          id: user.id,
          pseudo: showRealName ? null : user.pseudo,
          firstName: showRealName ? user.firstName : null,
          lastName: showRealName ? user.lastName : null,
          role: user.role,
          profile: user.profile
            ? { id: user.profile.id, avatar: user.profile.avatar }
            : null,
        }
      }),
    })
  } catch (err) {
    console.error('❌ GET /search/users :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
