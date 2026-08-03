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
// Smart feed : publications des follows + fallback populaire
router.get('/feed', requireAuth, async (req, res) => {
  const userId = req.user.id
  try {
    const profile = await prisma.profile.findUnique({ where: { userId } })
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' })

    // Follows (IDs d'utilisateurs)
    const follows = await prisma.follow.findMany({
      where: { followerId: userId },
      select: { followingId: true },
    })
    const followedUserIds = follows.map(f => f.followingId)
    const followCount = followedUserIds.length

    // Profils des follows
    const followedProfiles = followedUserIds.length > 0
      ? await prisma.profile.findMany({
          where: { userId: { in: followedUserIds } },
          select: { id: true },
        })
      : []
    const followedProfileIds = followedProfiles.map(p => p.id)

    // On inclut toujours ses propres publications dans le feed
    const feedProfileIds = [...new Set([profile.id, ...followedProfileIds])]

    // Publications des personnes suivies + les siennes
    let posts = []
    if (feedProfileIds.length > 0) {
      posts = await prisma.publication.findMany({
        where: { profileId: { in: feedProfileIds } },
        include: {
          profile: {
            include: {
              user: { select: { id: true, pseudo: true, firstName: true, lastName: true, role: true } },
            },
          },
          likes: { select: { profileId: true } },
          _count: { select: { comments: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: followCount >= 10 ? 20 : 10,
      })
    }

    // Fallback populaire si peu de follows ou peu de posts
    if (followCount < 10 || posts.length < 3) {
      const excludeIds = posts.map(p => p.id)
      const popular = await prisma.publication.findMany({
        where: {
          id: { notIn: excludeIds },
          profileId: { notIn: followedProfileIds }, // on ne retire plus le profil courant
        },
        include: {
          profile: {
            include: {
              user: { select: { id: true, pseudo: true, firstName: true, lastName: true, role: true } },
            },
          },
          likes: { select: { profileId: true } },
          _count: { select: { comments: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 12,
      })
      posts = [...posts, ...popular]
    }

    const result = posts.map(p => ({
      id: p.id,
      media: p.media,
      mediaType: p.mediaType,
      caption: p.caption,
      title: p.title,
      createdAt: p.createdAt,
      likesCount: p.likes.length,
      commentsCount: p._count?.comments ?? 0,
      likedByMe: p.likes.some(l => l.profileId === profile.id),
      isFromFollow: p.profileId === profile.id ? true : followedProfileIds.includes(p.profileId),
      author: {
        profileId: p.profileId,
        userId: p.profile?.user?.id ?? null,
        name: p.profile?.user ? getDisplayName(p.profile.user, p.profile) : 'Utilisateur',
        avatar: p.profile?.avatar || null,
        role: p.profile?.user?.role || null,
        profession: p.profile?.profession || p.profile?.specialties?.[0] || null,
        profileUrl: profileUrl(p.profile?.user ?? null),
      },
    }))

    res.json({ posts: result, followCount })
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
