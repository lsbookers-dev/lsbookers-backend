// routes/home.js
const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')

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

// ─── GET /api/home/carousel ─────────────────────────────────
// Profils mis en avant (abonnés premium) complétés par les plus suivis
router.get('/carousel', async (req, res) => {
  try {
    // 1. Abonnés actifs avec avatar
    const premiumUsers = await prisma.user.findMany({
      where: {
        subscription: { status: 'ACTIVE' },
        profile: { avatar: { not: null } },
        role: { in: ['ARTIST', 'ORGANIZER', 'PROVIDER'] },
      },
      include: { profile: true },
      take: 8,
    })

    // 2. Compléter avec les plus suivis si besoin
    let featured = premiumUsers
    if (featured.length < 4) {
      const excludeIds = featured.map(u => u.id)
      const more = await prisma.user.findMany({
        where: {
          id: { notIn: excludeIds },
          role: { in: ['ARTIST', 'ORGANIZER', 'PROVIDER'] },
          profile: { avatar: { not: null } },
        },
        include: {
          profile: true,
          _count: { select: { followers: true } },
        },
        take: 30,
      })
      // Trier par followers côté JS
      more.sort((a, b) => (b._count?.followers ?? 0) - (a._count?.followers ?? 0))
      featured = [...featured, ...more].slice(0, 8)
    }

    const result = featured.map(u => ({
      id: u.id,
      name: getDisplayName(u, u.profile),
      avatar: u.profile?.avatar || null,
      banner: u.profile?.banner || null,
      profession: u.profile?.profession || u.profile?.specialties?.[0] || null,
      location: u.profile?.location || u.profile?.city || null,
      role: u.role,
      isPremium: !!u.subscription,
      profileUrl: profileUrl(u),
    }))

    res.json({ featured: result })
  } catch (err) {
    console.error('❌ Home /carousel :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── GET /api/home/feed ─────────────────────────────────────
// Algorithme de feed progressif à 3 buckets
// Tier basé sur followingCount → ratios followed/trending/suggestion
router.get('/feed', requireAuth, async (req, res) => {
  const userId   = req.user.id
  const page     = Math.max(1, parseInt(req.query.page) || 1)
  const PAGE_SIZE = 20

  try {
    const [profile, follows] = await Promise.all([
      prisma.profile.findUnique({ where: { userId } }),
      prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } }),
    ])
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })

    const followedUserIds = follows.map(f => f.followingId)
    const followingCount  = followedUserIds.length

    // ── Ratios progressifs selon le niveau d'engagement ──────
    let followedRatio, trendingRatio, suggestionRatio
    if      (followingCount === 0) { followedRatio = 0.10; trendingRatio = 0.90; suggestionRatio = 0.00 }
    else if (followingCount <= 3)  { followedRatio = 0.20; trendingRatio = 0.80; suggestionRatio = 0.00 }
    else if (followingCount <= 9)  { followedRatio = 0.30; trendingRatio = 0.70; suggestionRatio = 0.00 }
    else if (followingCount <= 19) { followedRatio = 0.50; trendingRatio = 0.50; suggestionRatio = 0.00 }
    else if (followingCount <= 49) { followedRatio = 0.60; trendingRatio = 0.40; suggestionRatio = 0.00 }
    else                            { followedRatio = 0.70; trendingRatio = 0.20; suggestionRatio = 0.10 }

    const followedSlots   = Math.round(PAGE_SIZE * followedRatio)
    const suggestionSlots = Math.round(PAGE_SIZE * suggestionRatio)
    const trendingSlots   = PAGE_SIZE - followedSlots - suggestionSlots
    const pageSkip        = (page - 1) * PAGE_SIZE

    // ── Include commun ────────────────────────────────────────
    const PUB_INCLUDE = {
      profile: {
        include: {
          user: { select: { id: true, pseudo: true, firstName: true, lastName: true, role: true } },
        },
      },
      likes:           { select: { profileId: true } },
      _count:          { select: { comments: true } },
      additionalMedia: { orderBy: { order: 'asc' }, select: { id: true, url: true, mediaType: true, order: true } },
    }

    // ── Score = récence (7j) + engagement ────────────────────
    function score(pub) {
      const ageH    = (Date.now() - new Date(pub.createdAt).getTime()) / 3_600_000
      const recency = Math.max(0, 168 - ageH)
      return recency + (pub.likes?.length ?? 0) * 2 + (pub._count?.comments ?? 0) * 3
    }

    // ── Profils des follows ───────────────────────────────────
    const followedProfiles = followedUserIds.length > 0
      ? await prisma.profile.findMany({
          where: { userId: { in: followedUserIds } },
          select: { id: true },
        })
      : []
    const followedProfileIds       = followedProfiles.map(p => p.id)
    const ownAndFollowedProfileIds = [...new Set([profile.id, ...followedProfileIds])]

    // ── BUCKET 1 — Follows + propres publications ─────────────
    const rawFollowed = await prisma.publication.findMany({
      where:   { profileId: { in: ownAndFollowedProfileIds } },
      include: PUB_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take:    Math.max(followedSlots, 4) * 3,
      skip:    Math.floor(pageSkip * followedRatio),
    })
    const followedBucket = rawFollowed
      .map(p => ({ ...p, feedType: 'followed', _score: score(p) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, Math.max(followedSlots, 4))

    // ── BUCKET 2 — Trending (exclu : follows + propres) ──────
    const seenIds        = followedBucket.map(p => p.id)
    const seenProfileIds = ownAndFollowedProfileIds

    const rawTrending = await prisma.publication.findMany({
      where: {
        id:        { notIn: seenIds },
        profileId: { notIn: seenProfileIds },
        createdAt: { gte: new Date(Date.now() - 90 * 24 * 3_600_000) }, // 90 jours
      },
      include: PUB_INCLUDE,
      take:    trendingSlots * 4,
      skip:    Math.floor(pageSkip * trendingRatio),
    })
    const trendingBucket = rawTrending
      .map(p => ({ ...p, feedType: 'trending', _score: score(p) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, trendingSlots)

    // ── BUCKET 3 — Suggestions (amis des amis, tier 50+) ─────
    let suggestionBucket = []
    if (suggestionSlots > 0 && followedUserIds.length > 0) {
      const allSeenIds        = [...seenIds, ...trendingBucket.map(p => p.id)]
      const allSeenProfileIds = [...seenProfileIds, ...trendingBucket.map(p => p.profileId)]

      const fof = await prisma.follow.findMany({
        where: {
          followerId:  { in: followedUserIds },
          followingId: { notIn: [userId, ...followedUserIds] },
        },
        select: { followingId: true },
        take:   150,
      })
      const fofUserIds = [...new Set(fof.map(f => f.followingId))]

      if (fofUserIds.length > 0) {
        const fofProfiles   = await prisma.profile.findMany({
          where: { userId: { in: fofUserIds } },
          select: { id: true },
        })
        const fofProfileIds = fofProfiles
          .map(p => p.id)
          .filter(id => !allSeenProfileIds.includes(id))

        if (fofProfileIds.length > 0) {
          const rawSugg = await prisma.publication.findMany({
            where:   { id: { notIn: allSeenIds }, profileId: { in: fofProfileIds } },
            include: PUB_INCLUDE,
            take:    suggestionSlots * 3,
          })
          suggestionBucket = rawSugg
            .map(p => ({ ...p, feedType: 'suggestion', _score: score(p) }))
            .sort((a, b) => b._score - a._score)
            .slice(0, suggestionSlots)
        }
      }

      // Fallback trending si pas assez de suggestions
      if (suggestionBucket.length < suggestionSlots) {
        const missing     = suggestionSlots - suggestionBucket.length
        const allSeen2    = [...allSeenIds, ...suggestionBucket.map(p => p.id)]
        const fallback    = await prisma.publication.findMany({
          where:   { id: { notIn: allSeen2 }, profileId: { notIn: allSeenProfileIds } },
          include: PUB_INCLUDE,
          take:    missing * 3,
        })
        const extra = fallback
          .map(p => ({ ...p, feedType: 'suggestion', _score: score(p) }))
          .sort((a, b) => b._score - a._score)
          .slice(0, missing)
        suggestionBucket = [...suggestionBucket, ...extra]
      }
    }

    // ── Interleaver les 3 buckets ─────────────────────────────
    // Ex. ratio 70/20/10 → un trending tous les ~3,5 followed, un suggestion tous les ~7
    function interleave(primary, secondary, tertiary) {
      if (!primary.length) return [...secondary, ...tertiary]
      const result  = []
      const secStep = secondary.length > 0
        ? Math.max(1, Math.ceil(primary.length / secondary.length))
        : Infinity
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

    const merged = interleave(followedBucket, trendingBucket, suggestionBucket)

    // ── Formatter la réponse ──────────────────────────────────
    const posts = merged.map(p => ({
      id:              p.id,
      media:           p.media,
      mediaType:       p.mediaType,
      caption:         p.caption,
      title:           p.title,
      createdAt:       p.createdAt,
      likesCount:      p.likes.length,
      commentsCount:   p._count?.comments ?? 0,
      likedByMe:       p.likes.some(l => l.profileId === profile.id),
      isFromFollow:    p.feedType === 'followed',
      feedType:        p.feedType,
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
    }))

    // ── Publications admin (prioritaires — affichées en tête) ─
    const adminPosts = page === 1
      ? await prisma.adminPost.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' } })
      : []

    res.json({
      posts,
      followCount: followingCount,
      adminPosts,
      page,
      hasMore: posts.length >= PAGE_SIZE,
    })
  } catch (err) {
    console.error('❌ Home /feed :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── GET /api/home/top ──────────────────────────────────────
// Top artistes ou prestataires (followers + moyenne avis)
router.get('/top', async (req, res) => {
  const { role = 'ARTIST', country = '', city = '' } = req.query
  const prismaRole = role === 'ARTIST' ? 'ARTIST' : 'PROVIDER'

  try {
    const profileWhere = {}
    if (country) profileWhere.country = { contains: country, mode: 'insensitive' }
    if (city)    profileWhere.city    = { contains: city,    mode: 'insensitive' }

    const users = await prisma.user.findMany({
      where: {
        role: prismaRole,
        profile: Object.keys(profileWhere).length > 0 ? profileWhere : undefined,
      },
      include: {
        profile: {
          include: { reviewsReceived: { select: { rating: true } } },
        },
        _count: { select: { followers: true } },
      },
      take: 50,
    })

    const scored = users
      .filter(u => u.profile)
      .map(u => {
        const ratings = u.profile.reviewsReceived.map(r => r.rating)
        const avgRating = ratings.length
          ? ratings.reduce((a, b) => a + b, 0) / ratings.length
          : 0
        return {
          id: u.id,
          name: getDisplayName(u, u.profile),
          avatar: u.profile.avatar,
          profession: u.profile.profession || u.profile.specialties?.[0] || null,
          location: u.profile.location || u.profile.city || null,
          followersCount: u._count.followers,
          avgRating: Math.round(avgRating * 10) / 10,
          reviewsCount: ratings.length,
          profileUrl: profileUrl(u),
          score: u._count.followers * 2 + avgRating * 10,
        }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)

    res.json({ top: scored })
  } catch (err) {
    console.error('❌ Home /top :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ─── GET /api/home/suggested ────────────────────────────────
// Suggestions de profils à suivre (même pays, pas encore suivis)
router.get('/suggested', requireAuth, async (req, res) => {
  const userId = req.user.id
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    })

    const alreadyFollowing = await prisma.follow.findMany({
      where: { followerId: userId },
      select: { followingId: true },
    })
    const excludeIds = [userId, ...alreadyFollowing.map(f => f.followingId)]

    const profileWhere = { avatar: { not: null } }
    if (user?.profile?.country) {
      profileWhere.country = user.profile.country
    }

    const candidates = await prisma.user.findMany({
      where: {
        id: { notIn: excludeIds },
        role: { in: ['ARTIST', 'ORGANIZER', 'PROVIDER'] },
        profile: profileWhere,
      },
      include: {
        profile: true,
        _count: { select: { followers: true } },
      },
      take: 30,
    })

    candidates.sort((a, b) => (b._count?.followers ?? 0) - (a._count?.followers ?? 0))

    const result = candidates.slice(0, 5).map(u => ({
      id: u.id,
      name: getDisplayName(u, u.profile),
      avatar: u.profile?.avatar || null,
      profession: u.profile?.profession || u.profile?.specialties?.[0] || null,
      location: u.profile?.location || u.profile?.city || null,
      followersCount: u._count.followers,
      role: u.role,
      profileUrl: profileUrl(u),
    }))

    res.json({ suggested: result })
  } catch (err) {
    console.error('❌ Home /suggested :', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
