const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { boostPro, isProRow, managedProUserIds } = require('../lib/plan')
const { haversineKm, boundingBoxWhere } = require('../lib/geo')

// fetch compatible CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))

// Cache simple en mémoire pour éviter de géocoder 10 fois la même ville (taille bornée)
const geoCache = new Map()
const GEO_CACHE_MAX = 2000
function rememberGeo(key, value) {
  if (geoCache.size >= GEO_CACHE_MAX) geoCache.delete(geoCache.keys().next().value)
  geoCache.set(key, value)
}

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
  // Badge Pro et coup de pouce dans les résultats (abonnement Pro ou formule Agence)
  subscription: { select: { status: true, endDate: true, currentPeriodEnd: true } },
  agencySubscription: { select: { status: true, endDate: true, currentPeriodEnd: true } },
  profile: {
    select: {
      location: true,
      country: true,
      specialties: true,
      styles: true,
      typeEtablissement: true,
      avatar: true,
      showRealName: true,
    },
  },
}

function toPublicSearchUser(user, managedPro) {
  const profile = user.profile
  const showRealName = profile?.showRealName === true

  return {
    id: user.id,
    pseudo: showRealName ? null : user.pseudo,
    firstName: showRealName ? user.firstName : null,
    lastName: showRealName ? user.lastName : null,
    role: user.role,
    createdAt: user.createdAt,
    isPro: isProRow(user, managedPro),
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
          'User-Agent': 'LSBookers/1.0 (contact@lsbookers.com)',
          'Accept-Language': 'fr,en',
        },
      }
    )

    if (!res.ok) {
      // Panne passagère : on ne la garde pas en cache, la prochaine recherche réessaiera
      console.warn(`⚠️ Nominatim a répondu ${res.status} pour "${query}"`)
      return null
    }

    const data = await res.json()

    if (Array.isArray(data) && data.length > 0) {
      const result = {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
      }
      rememberGeo(normalized, result)
      return result
    }

    rememberGeo(normalized, null)
    return null
  } catch (err) {
    console.warn('⚠️ Géocodage impossible pour :', query)
    return null
  }
}

const PAGE_SIZE = 24
const MAX_PAGE_SIZE = 50

// Liste de valeurs « a,b,c » → ensemble en minuscules
function parseList(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '')
  return new Set(raw.split(',').map(normalizeText).filter(Boolean))
}

// Nom affiché sur la carte (pour le tri alphabétique)
function displayName(user) {
  const showRealName = user.profile?.showRealName === true
  const name = showRealName ? [user.firstName, user.lastName].filter(Boolean).join(' ') : user.pseudo
  return normalizeText(name)
}

/**
 * GET /api/search — résultats par pages de 24
 * Filtres :
 * - name, role, country, date
 * - specialties : spécialités / types d'établissement, séparés par des virgules
 * - styles : styles musicaux (ne filtre que les artistes)
 * - zone (+ radius en km pour une vraie distance)
 * - sort : recent (défaut) | alpha
 * - cursor : position de départ (renvoyée par la page précédente), limit
 * Réponse : { users, total, counts, hasMore, nextCursor }
 */
router.get('/', requireAuth, async (req, res) => {
  const { name, role, specialty, typeEtablissement, zone, radius, country, date, sort } = req.query

  const hasRadiusFilter = radius !== undefined && radius !== null && radius !== ''
  const effectiveRadius = hasRadiusFilter ? parseFloat(radius) : null
  const zoneText = normalizeText(zone)
  const specialties = parseList(req.query.specialties)
  const styles = parseList(req.query.styles)
  const cursor = Math.max(parseInt(req.query.cursor, 10) || 0, 0)
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const empty = { users: [], total: 0, counts: { ARTIST: 0, ORGANIZER: 0, PROVIDER: 0 }, hasMore: false, nextCursor: null }

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
      return res.json(empty)
    }

    // Zone + rayon : seule la ville cherchée est géocodée (les profils ont leurs coordonnées en base)
    let searchCoords = null
    if (zoneText && hasRadiusFilter) {
      searchCoords = await geocodeLocation(String(zone))
      if (!searchCoords || Number.isNaN(effectiveRadius)) return res.json(empty)
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

    const where = {
      role: { not: 'ADMIN' },
      emailVerified: true,
      // Réglages : comptes en pause et membres qui ne veulent pas apparaître dans la Recherche
      pausedAt: null,
      bannedAt: null,
      id: { not: req.user.id, notIn: blockedIds.length ? blockedIds : undefined },

      ...(name && buildPublicNameFilter(name)),

      ...(role &&
        String(role).toUpperCase() !== 'ADMIN' && {
          role: String(role).toUpperCase(),
        }),

      profile: {
        hiddenFromSearch: false,
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

        // Zone seule : recherche texte sur la ville / zone
        ...(zoneText && !hasRadiusFilter && {
          location: { contains: zoneText, mode: 'insensitive' },
        }),

        // Zone + rayon : la base ne renvoie que les profils proches (carré autour de la ville)
        ...(searchCoords && boundingBoxWhere(searchCoords.lat, searchCoords.lon, effectiveRadius)),

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
    }

    // 1) Liste légère de tous les résultats (quelques champs seulement) pour le tri et le comptage
    const candidates = await prisma.user.findMany({
      where,
      select: {
        id: true,
        role: true,
        pseudo: true,
        firstName: true,
        lastName: true,
        subscription: { select: { status: true, endDate: true, currentPeriodEnd: true } },
        agencySubscription: { select: { status: true, endDate: true, currentPeriodEnd: true } },
        profile: {
          select: {
            showRealName: true,
            specialties: true,
            styles: true,
            typeEtablissement: true,
            latitude: true,
            longitude: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    let ranked = candidates.filter((user) => {
      const p = user.profile
      if (!p) return false

      // Distance exacte (le carré de la base est un peu plus large que le cercle)
      if (searchCoords) {
        if (p.latitude == null || p.longitude == null) return false
        if (haversineKm(searchCoords.lat, searchCoords.lon, p.latitude, p.longitude) > effectiveRadius) return false
      }

      if (specialties.size > 0) {
        const values = user.role === 'ORGANIZER' ? [p.typeEtablissement] : (p.specialties || [])
        if (!values.some(v => specialties.has(normalizeText(v)))) return false
      }

      // Styles musicaux : ne concernent que les artistes
      if (styles.size > 0 && user.role === 'ARTIST') {
        if (!(p.styles || []).some(v => styles.has(normalizeText(v)))) return false
      }

      return true
    })

    // Profils gérés par une agence qui a la formule : Pro aussi
    const managedPro = await managedProUserIds(ranked.map(u => u.id))
    ranked = sort === 'alpha'
      ? [...ranked].sort((a, b) => displayName(a).localeCompare(displayName(b), 'fr'))
      : boostPro(ranked, u => isProRow(u, managedPro))

    const counts = { ARTIST: 0, ORGANIZER: 0, PROVIDER: 0 }
    for (const u of ranked) if (u.role in counts) counts[u.role]++

    // 2) Fiches complètes de la page demandée uniquement
    const pageIds = ranked.slice(cursor, cursor + limit).map(u => u.id)
    const pageUsers = pageIds.length
      ? await prisma.user.findMany({ where: { id: { in: pageIds } }, select: publicSearchSelect })
      : []
    const byId = new Map(pageUsers.map(u => [u.id, u]))
    const users = pageIds.map(id => byId.get(id)).filter(Boolean).map(u => toPublicSearchUser(u, managedPro))

    const nextCursor = cursor + limit < ranked.length ? cursor + limit : null
    return res.json({ users, total: ranked.length, counts, hasMore: nextCursor !== null, nextCursor })
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
        pausedAt: null, // compte en pause : on ne peut pas l'identifier ni le choisir
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
