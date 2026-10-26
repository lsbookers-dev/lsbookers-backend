// routes/home.js
const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { getBlockedProfileIds } = require('../lib/blocks')
const { requireAuth, optionalAuth } = require('../middleware/auth')
const { carouselFeatured } = require('../services/extras')
const { ensureProfileRegion } = require('../lib/regions')
const { isProRow, managedProUserIds } = require('../lib/plan')
const { boundingBoxWhere } = require('../lib/geo')

const MEMBER_ROLES = ['ARTIST', 'ORGANIZER', 'PROVIDER']

// ─── Helper : nom d'affichage ───────────────────────────────
function getDisplayName(user, profile) {
  if (profile?.showRealName && user?.firstName) {
    return `${user.firstName} ${user.lastName || ''}`.trim()
  }
  return user?.pseudo || user?.firstName || 'Utilisateur'
}

// ─── Helper : URL de profil selon le rôle ──────────────────
function profileUrl(user) {
  if (!user) return '#'
  if (user.role === 'ARTIST')    return `/artist/${user.id}`
  if (user.role === 'ORGANIZER') return `/organizer/${user.id}`
  return `/provider/${user.id}`
}

// ─── Helper : curseur opaque (base64 d'un petit objet JSON) ─
function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
function decodeCursor(raw) {
  try { return JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')) } catch { return null }
}

// Publications strictement plus anciennes que { d: date ISO, id } (ordre date puis id décroissants)
function olderThan(mark) {
  if (!mark?.d || !mark?.id) return {}
  const date = new Date(mark.d)
  if (Number.isNaN(date.getTime())) return {}
  return { OR: [{ createdAt: { lt: date } }, { createdAt: date, id: { lt: Number(mark.id) } }] }
}

// ─── Distance en km entre deux points (formule de haversine) ─
function distanceKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180
  const dLat = rad(b.latitude - a.latitude)
  const dLon = rad(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

const sameText = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

// ─── Include et format communs des publications du fil ─────
const PUB_INCLUDE = {
  profile: {
    include: {
      user: { select: { id: true, pseudo: true, firstName: true, lastName: true, role: true } },
    },
  },
  _count:          { select: { likes: true, comments: true } },
  additionalMedia: { orderBy: { order: 'asc' }, select: { id: true, url: true, mediaType: true, order: true } },
  tags: {
    where:  { status: 'ACCEPTED' },
    select: {
      id: true, status: true,
      taggedUser: {
        select: {
          id: true, pseudo: true, firstName: true, lastName: true,
          profile: { select: { id: true, avatar: true } },
        },
      },
    },
  },
}

async function likedPublicationIds(viewerProfileId, publications) {
  const ids = publications.map(p => p.id)
  if (!ids.length) return new Set()
  const likes = await prisma.publicationLike.findMany({
    where: { profileId: viewerProfileId, publicationId: { in: ids } },
    select: { publicationId: true },
  })
  return new Set(likes.map(l => l.publicationId))
}

function formatPost(p, likedIds) {
  return {
    id:              p.id,
    media:           p.media,
    mediaType:       p.mediaType,
    caption:         p.caption,
    title:           p.title,
    createdAt:       p.createdAt,
    likesCount:      p._count?.likes ?? 0,
    commentsCount:   p._count?.comments ?? 0,
    likedByMe:       likedIds.has(p.id),
    isFromFollow:    p.feedType === 'followed',
    feedType:        p.feedType ?? null,
    additionalMedia: p.additionalMedia ?? [],
    author: {
      profileId:  p.profileId,
      userId:     p.profile?.user?.id ?? null,
      name:       p.profile?.user ? getDisplayName(p.profile.user, p.profile) : 'Utilisateur',
      avatar:     p.profile?.avatar || null,
      role:       p.profile?.user?.role || null,
      profession: p.profile?.profession || p.profile?.specialties?.[0] || null,
      profileUrl: profileUrl(p.profile?.user ?? null),
    },
  }
}

// ─── GET /api/home/carousel ─────────────────────────────────
// Profils mis en avant : offerts par l'admin (partout), payés en national (toute la France)
// et payés en régional (seulement auprès des membres de la même région).
// Tant qu'aucun profil n'est choisi, on montre les profils les plus suivis.
router.get('/carousel', optionalAuth, async (req, res) => {
  try {
    let viewerRegion = null
    if (req.user?.profile?.id) viewerRegion = await ensureProfileRegion(req.user.profile.id).catch(() => null)
    const selected = await carouselFeatured(viewerRegion)

    let featured = selected.map(f => ({ user: f.profile.user, profile: f.profile, isFeatured: true }))

    if (featured.length === 0) {
      const popular = await prisma.user.findMany({
        where: { role: { in: MEMBER_ROLES }, pausedAt: null, bannedAt: null, profile: { avatar: { not: null }, hiddenFromSearch: false } },
        include: { profile: true, _count: { select: { followers: true } } },
        take: 30,
      })
      popular.sort((a, b) => (b._count?.followers ?? 0) - (a._count?.followers ?? 0))
      featured = popular.slice(0, 8).map(u => ({ user: u, profile: u.profile, isFeatured: false }))
    }

    res.json({
      featured: featured.map(({ user, profile, isFeatured }) => ({
        id: user.id,
        name: getDisplayName(user, profile),
        avatar: profile?.avatar || null,
        banner: profile?.banner || null,
        profession: profile?.profession || profile?.specialties?.[0] || null,
        location: profile?.location || profile?.city || null,
        role: user.role,
        isFeatured,
        profileUrl: profileUrl(user),
      })),
    })
  } catch (err) {
    console.error('❌ Home /carousel :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── GET /api/home/feed?cursor= ─────────────────────────────
// « Pour vous » : 3 sources mélangées selon le nombre d'abonnements
//   1. publications des comptes suivis (+ les siennes), de la plus récente à la plus ancienne
//   2. tendances : les publications des 90 derniers jours les mieux notées (récence + engagement)
//   3. suggestions (50 abonnements et plus) : les amis de vos amis
// Le curseur retient où en est chaque source : aucune publication sautée ni répétée d'une page à l'autre.
const FEED_PAGE = 20
const TRENDING_WINDOW_DAYS = 90

// Score = récence (7 j) + engagement
function feedScore(pub) {
  const ageH    = (Date.now() - new Date(pub.createdAt).getTime()) / 3_600_000
  const recency = Math.max(0, 168 - ageH)
  return recency + (pub._count?.likes ?? 0) * 2 + (pub._count?.comments ?? 0) * 3
}

// Classe toutes les publications qui répondent à `where` et en renvoie un morceau (skip/take)
// Publications des comptes en pause : invisibles des autres membres
const NOT_PAUSED = { profile: { user: { pausedAt: null } } }

async function rankedPublications(where, skip, take, feedType) {
  if (take <= 0) return { items: [], total: 0 }
  const rows = await prisma.publication.findMany({
    where: { ...where, ...NOT_PAUSED },
    select: { id: true, createdAt: true, _count: { select: { likes: true, comments: true } } },
  })
  const ids = rows
    .map(r => ({ id: r.id, score: feedScore(r) }))
    .sort((a, b) => b.score - a.score || b.id - a.id)
    .slice(skip, skip + take)
    .map(r => r.id)
  if (!ids.length) return { items: [], total: rows.length }
  const full = await prisma.publication.findMany({ where: { id: { in: ids } }, include: PUB_INCLUDE })
  const byId = new Map(full.map(p => [p.id, p]))
  return {
    items: ids.map(id => byId.get(id)).filter(Boolean).map(p => ({ ...p, feedType })),
    total: rows.length,
  }
}

// Mélange : un « secondaire » tous les n « principaux », un « tertiaire » tous les m
function interleave(primary, secondary, tertiary) {
  if (!primary.length) return [...secondary, ...tertiary]
  const result  = []
  const secStep = secondary.length > 0 ? Math.max(1, Math.ceil(primary.length / secondary.length)) : Infinity
  const terStep = tertiary.length > 0
    ? Math.max(1, Math.ceil((primary.length + secondary.length) / Math.max(1, tertiary.length)))
    : Infinity
  let si = 0, ti = 0
  for (let i = 0; i < primary.length; i++) {
    result.push(primary[i])
    if (si < secondary.length && (i + 1) % secStep === 0) result.push(secondary[si++])
    if (ti < tertiary.length  && (i + 1) % terStep  === 0) result.push(tertiary[ti++])
  }
  while (si < secondary.length) result.push(secondary[si++])
  while (ti < tertiary.length)  result.push(tertiary[ti++])
  return result
}

router.get('/feed', requireAuth, async (req, res) => {
  const userId = req.user.id
  const cursor = req.query.cursor ? decodeCursor(req.query.cursor) : { f: null, t: 0, s: 0 }
  if (!cursor) return res.status(400).json({ error: 'Curseur invalide' })
  const isFirstPage = !req.query.cursor

  try {
    const [profile, follows, blockedProfileIds] = await Promise.all([
      prisma.profile.findUnique({ where: { userId } }),
      prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } }),
      getBlockedProfileIds(userId),
    ])
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })

    const followedUserIds = follows.map(f => f.followingId)
    const followingCount  = followedUserIds.length

    // ── Ratios progressifs selon le niveau d'engagement ──────
    let followedRatio, suggestionRatio
    if      (followingCount === 0) { followedRatio = 0.10; suggestionRatio = 0.00 }
    else if (followingCount <= 3)  { followedRatio = 0.20; suggestionRatio = 0.00 }
    else if (followingCount <= 9)  { followedRatio = 0.30; suggestionRatio = 0.00 }
    else if (followingCount <= 19) { followedRatio = 0.50; suggestionRatio = 0.00 }
    else if (followingCount <= 49) { followedRatio = 0.60; suggestionRatio = 0.00 }
    else                            { followedRatio = 0.70; suggestionRatio = 0.10 }

    // Même répartition qu'à l'origine : au moins 4 publications suivies, les tendances complètent
    const rawFollowedSlots = Math.round(FEED_PAGE * followedRatio)
    const followedSlots    = Math.max(rawFollowedSlots, 4)
    const suggestionSlots  = Math.round(FEED_PAGE * suggestionRatio)
    const trendingSlots    = FEED_PAGE - rawFollowedSlots - suggestionSlots

    // ── Profils suivis (hors blocages) + le sien ──────────────
    const followedProfiles = followedUserIds.length > 0
      ? await prisma.profile.findMany({ where: { userId: { in: followedUserIds } }, select: { id: true } })
      : []
    const followedProfileIds       = followedProfiles.map(p => p.id).filter(id => !blockedProfileIds.includes(id))
    const ownAndFollowedProfileIds = [...new Set([profile.id, ...followedProfileIds])]

    // ── SOURCE 1 — Comptes suivis + ses publications (chronologique) ─
    let followedBucket = []
    let nextFollowed   = 'end'
    if (cursor.f !== 'end') {
      const rows = await prisma.publication.findMany({
        where:   { profileId: { in: ownAndFollowedProfileIds }, AND: [olderThan(cursor.f), { OR: [{ profileId: profile.id }, NOT_PAUSED] }] },
        include: PUB_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take:    followedSlots + 1,
      })
      followedBucket = rows.slice(0, followedSlots).map(p => ({ ...p, feedType: 'followed' }))
      const last = followedBucket.at(-1)
      if (rows.length > followedSlots && last) nextFollowed = { d: last.createdAt.toISOString(), id: last.id }
    }

    // ── SOURCE 3 — Suggestions : amis des amis (50 abonnements et plus) ─
    let fofProfileIds = []
    if (suggestionSlots > 0) {
      const fof = await prisma.follow.findMany({
        where:  { followerId: { in: followedUserIds }, followingId: { notIn: [userId, ...followedUserIds] } },
        select: { followingId: true },
        take:   150,
      })
      const fofUserIds = [...new Set(fof.map(f => f.followingId))]
      if (fofUserIds.length) {
        const rows = await prisma.profile.findMany({ where: { userId: { in: fofUserIds } }, select: { id: true } })
        fofProfileIds = rows.map(p => p.id).filter(id => !blockedProfileIds.includes(id))
      }
    }
    const suggestions = fofProfileIds.length
      ? await rankedPublications({ profileId: { in: fofProfileIds } }, Number(cursor.s) || 0, suggestionSlots, 'suggestion')
      : { items: [], total: 0 }

    // ── SOURCE 2 — Tendances (reçoit aussi les places laissées libres) ─
    const freeSlots = (followedSlots - followedBucket.length) + (suggestionSlots - suggestions.items.length)
    const trending = await rankedPublications({
      profileId: { notIn: [...ownAndFollowedProfileIds, ...blockedProfileIds, ...fofProfileIds] },
      createdAt: { gte: new Date(Date.now() - TRENDING_WINDOW_DAYS * 24 * 3_600_000) },
    }, Number(cursor.t) || 0, trendingSlots + freeSlots, 'trending')

    // Dans une page, les publications suivies sont présentées des plus intéressantes aux moins intéressantes
    followedBucket.sort((a, b) => feedScore(b) - feedScore(a))
    const merged   = interleave(followedBucket, trending.items, suggestions.items)
    const likedIds = await likedPublicationIds(profile.id, merged)

    const nextT = (Number(cursor.t) || 0) + trending.items.length
    const nextS = (Number(cursor.s) || 0) + suggestions.items.length
    const hasMore = nextFollowed !== 'end' || nextT < trending.total || nextS < suggestions.total

    // ── Publications admin (première page seulement) ──────────
    const adminPosts = isFirstPage
      ? await prisma.adminPost.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' } })
      : []

    res.json({
      posts: merged.map(p => formatPost(p, likedIds)),
      followCount: followingCount,
      adminPosts,
      hasMore,
      nextCursor: hasMore ? encodeCursor({ f: nextFollowed, t: nextT, s: nextS }) : null,
    })
  } catch (err) {
    console.error('❌ Home /feed :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── GET /api/home/nearby?cursor= ───────────────────────────
// « À proximité » : publications des membres de votre région (100 km autour de votre ville),
// de la plus récente à la plus ancienne. Sans coordonnées, on compare le nom de la ville.
const NEARBY_RADIUS_KM = 100
const NEARBY_PAGE = 20

router.get('/nearby', requireAuth, async (req, res) => {
  const mark = req.query.cursor ? decodeCursor(req.query.cursor) : null
  try {
    const [viewer, blockedProfileIds] = await Promise.all([
      prisma.profile.findUnique({
        where: { userId: req.user.id },
        select: { id: true, latitude: true, longitude: true, city: true, location: true },
      }),
      getBlockedProfileIds(req.user.id),
    ])
    if (!viewer) return res.status(404).json({ error: 'Profil introuvable' })

    const region    = viewer.location || viewer.city || null
    const hasCoords = viewer.latitude != null && viewer.longitude != null
    if (!hasCoords && !region) {
      return res.json({ posts: [], hasMore: false, nextCursor: null, needsLocation: true, region: null, radiusKm: NEARBY_RADIUS_KM })
    }

    // La base ne renvoie que les profils de la région : ceux dans le carré de 100 km autour
    // de votre ville, ou (sans coordonnées) ceux qui portent le même nom de ville
    const sameCity = [viewer.city, viewer.location]
      .filter(v => v && v.trim())
      .flatMap(v => [
        { city: { equals: v.trim(), mode: 'insensitive' } },
        { location: { equals: v.trim(), mode: 'insensitive' } },
      ])
    const cityWhere = hasCoords
      ? [{ latitude: null }, { longitude: null }].map(noCoords => ({ ...noCoords, OR: sameCity }))
      : sameCity
    const candidates = await prisma.profile.findMany({
      where: {
        id: { notIn: [viewer.id, ...blockedProfileIds] },
        user: { role: { in: MEMBER_ROLES }, pausedAt: null },
        OR: [
          ...(hasCoords ? [boundingBoxWhere(viewer.latitude, viewer.longitude, NEARBY_RADIUS_KM)] : []),
          ...(sameCity.length ? cityWhere : []),
        ],
      },
      select: { id: true, latitude: true, longitude: true, city: true, location: true },
    })
    const nearbyIds = candidates
      .filter(p => (hasCoords && p.latitude != null && p.longitude != null)
        ? distanceKm(viewer, p) <= NEARBY_RADIUS_KM
        : [viewer.city, viewer.location].some(v => sameText(v, p.city) || sameText(v, p.location)))
      .map(p => p.id)

    const rows = nearbyIds.length
      ? await prisma.publication.findMany({
          where:   { profileId: { in: nearbyIds }, ...olderThan(mark) },
          include: PUB_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take:    NEARBY_PAGE + 1,
        })
      : []
    const page     = rows.slice(0, NEARBY_PAGE)
    const hasMore  = rows.length > NEARBY_PAGE
    const likedIds = await likedPublicationIds(viewer.id, page)
    const last     = page.at(-1)

    res.json({
      posts: page.map(p => formatPost(p, likedIds)),
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ d: last.createdAt.toISOString(), id: last.id }) : null,
      needsLocation: false,
      region,
      radiusKm: NEARBY_RADIUS_KM,
    })
  } catch (err) {
    console.error('❌ Home /nearby :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── GET /api/home/trends?role=&specialty=&city=&limit= ────
// Un seul classement par rôle, sur les 30 derniers jours, qui mélange tous les critères en points
// (choix d'Antho, 16/10/2026) :
//   booking accepté ou terminé via le site = 10 pts · profil ouvert depuis la Recherche = 3 pts
//   visite du profil = 1 pt · J'aime reçu sur une publication = 1 pt
// Un visiteur n'est compté qu'une fois par jour et par profil (recherches, visites).
// Plus tard : les avis reçus deviendront un critère de plus.
const TREND_DAYS = 30
const TREND_POINTS = { bookings: 10, search: 3, views: 1, likes: 1 }

const countMap = (rows, key) => new Map(rows.map(r => [Number(r[key]), Number(r._count?._all ?? r.count)]))

async function trendScores(since) {
  const [search, views, bookings, likes] = await Promise.all([
    prisma.profileSearchHit.groupBy({ by: ['profileId'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.profileView.groupBy({ by: ['profileId'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.bookingRequest.groupBy({
      by: ['targetId'],
      where: { status: { in: ['ACCEPTED', 'COMPLETED'] }, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.$queryRaw`
      SELECT p."profileId" AS "profileId", COUNT(*)::int AS "count"
      FROM "PublicationLike" l JOIN "Publication" p ON p."id" = l."publicationId"
      WHERE l."createdAt" >= ${since}
      GROUP BY p."profileId"`,
  ])
  const parts = {
    search: countMap(search, 'profileId'),
    views: countMap(views, 'profileId'),
    bookings: countMap(bookings, 'targetId'),
    likes: countMap(likes, 'profileId'),
  }
  const scores = new Map()
  for (const [criterion, map] of Object.entries(parts)) {
    for (const [profileId, count] of map) {
      scores.set(profileId, (scores.get(profileId) || 0) + count * TREND_POINTS[criterion])
    }
  }
  return scores
}

router.get('/trends', optionalAuth, async (req, res) => {
  const role      = req.query.role === 'PROVIDER' ? 'PROVIDER' : 'ARTIST'
  const specialty = String(req.query.specialty || '').trim()
  const city      = String(req.query.city || '').trim()
  const limit     = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 5))

  try {
    const scores = await trendScores(new Date(Date.now() - TREND_DAYS * 24 * 3_600_000))
    const blockedProfileIds = req.user ? await getBlockedProfileIds(req.user.id) : []
    const ids = [...scores.keys()].filter(id => !blockedProfileIds.includes(id))

    const profiles = ids.length
      ? await prisma.profile.findMany({
          where: {
            id: { in: ids },
            // Réglages : comptes en pause et membres qui ne veulent pas apparaître dans les Tendances
            user: { role, pausedAt: null, bannedAt: null },
            hiddenFromSearch: false,
            ...(city ? { OR: [{ city: { contains: city, mode: 'insensitive' } }, { location: { contains: city, mode: 'insensitive' } }] } : {}),
          },
          include: { user: { select: { id: true, pseudo: true, firstName: true, lastName: true, role: true, subscription: { select: { status: true, endDate: true, currentPeriodEnd: true } }, agencySubscription: { select: { status: true, endDate: true, currentPeriodEnd: true } } } } },
        })
      : []

    // Spécialités présentes dans le classement (filtres de la fenêtre « Voir plus »), les plus fréquentes d'abord
    const specialtyCount = new Map()
    for (const p of profiles) for (const s of p.specialties || []) specialtyCount.set(s, (specialtyCount.get(s) || 0) + 1)
    const specialties = [...specialtyCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr')).map(([s]) => s)

    const managedPro = await managedProUserIds(profiles.map(p => p.user.id))
    const items = profiles
      .filter(p => !specialty || (p.specialties || []).includes(specialty))
      .map(p => ({
        id: p.user.id,
        profileId: p.id,
        name: getDisplayName(p.user, p),
        avatar: p.avatar || null,
        profession: p.profession || p.specialties?.[0] || null,
        location: p.location || p.city || null,
        // Léger coup de pouce aux comptes Pro (+10 % de points)
        score: (scores.get(p.id) || 0) * (isProRow(p.user, managedPro) ? 1.1 : 1),
        isPro: isProRow(p.user, managedPro),
        profileUrl: profileUrl(p.user),
      }))
      .sort((a, b) => b.score - a.score || a.profileId - b.profileId)
      .slice(0, limit)

    // Le barème reste côté serveur : les membres ne le voient pas (choix d'Antho)
    res.json({ role, periodDays: TREND_DAYS, items, specialties })
  } catch (err) {
    console.error('❌ Home /trends :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
