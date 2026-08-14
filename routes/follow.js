const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { createNotif, displayName } = require('../services/notifications')

/* =========================================================
 *  POST /api/follow/:id  — Suivre un utilisateur
 * =======================================================*/
router.post('/:id', requireAuth, async (req, res) => {
  const followerId = req.user.id
  const followedId = parseInt(req.params.id, 10)

  if (!Number.isFinite(followedId)) return res.status(400).json({ error: 'ID invalide' })
  if (followerId === followedId) return res.status(400).json({ error: 'Impossible de se suivre soi-même' })

  try {
    // Vérifier que la cible existe et n'est pas bloquée
    const target = await prisma.user.findUnique({ where: { id: followedId }, select: { id: true } })
    if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' })

    const isBlocked = await prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: followerId, blockedId: followedId },
          { blockerId: followedId, blockedId: followerId },
        ],
      },
    })
    if (isBlocked) return res.status(403).json({ error: 'Action impossible' })

    const follow = await prisma.follow.upsert({
      where: { followerId_followingId: { followerId, followingId: followedId } },
      create: { followerId, followingId: followedId },
      update: {},
    })

    // Notification
    const follower = await prisma.user.findUnique({
      where: { id: followerId },
      select: { pseudo: true, firstName: true, lastName: true },
    })
    const followerName = displayName(follower)

    await createNotif({
      userId:  followedId,
      actorId: followerId,
      type:    'NEW_FOLLOW',
      content: `${followerName} vous suit maintenant.`,
    })

    return res.json({ ok: true, follow })
  } catch (error) {
    console.error('Erreur follow :', error)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
 *  DELETE /api/follow/:id  — Ne plus suivre un utilisateur
 * =======================================================*/
router.delete('/:id', requireAuth, async (req, res) => {
  const followerId = req.user.id
  const followedId = parseInt(req.params.id, 10)

  if (!Number.isFinite(followedId)) return res.status(400).json({ error: 'ID invalide' })

  try {
    await prisma.follow.deleteMany({
      where: { followerId, followingId: followedId },
    })
    return res.json({ ok: true })
  } catch (error) {
    console.error('Erreur unfollow :', error)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
 *  GET /api/follow/status/:id  — Est-ce que je suis ce user ?
 * =======================================================*/
router.get('/status/:id', requireAuth, async (req, res) => {
  const followerId = req.user.id
  const followedId = parseInt(req.params.id, 10)

  if (!Number.isFinite(followedId)) return res.status(400).json({ error: 'ID invalide' })

  try {
    const follow = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId: followedId } },
    })
    return res.json({ following: !!follow })
  } catch (error) {
    console.error('Erreur status follow :', error)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
 *  GET /api/follow/following  — Les gens que je suis
 * =======================================================*/
router.get('/following', requireAuth, async (req, res) => {
  try {
    const followings = await prisma.follow.findMany({
      where: { followerId: req.user.id },
      include: {
        following: {
          select: {
            id: true, pseudo: true, firstName: true, lastName: true, role: true,
            profile: { select: { id: true, avatar: true, location: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({ following: followings })
  } catch (error) {
    console.error('Erreur following :', error)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
 *  GET /api/follow/followers  — Mes abonnés
 * =======================================================*/
router.get('/followers', requireAuth, async (req, res) => {
  try {
    const followers = await prisma.follow.findMany({
      where: { followingId: req.user.id },
      include: {
        follower: {
          select: {
            id: true, pseudo: true, firstName: true, lastName: true, role: true,
            profile: { select: { id: true, avatar: true, location: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({ followers })
  } catch (error) {
    console.error('Erreur followers :', error)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
 *  GET /api/follow/contacts — retourne les followers + suivis de l'utilisateur connecté
 * =======================================================*/
router.get('/contacts', requireAuth, async (req, res) => {
  const userId = req.user.id
  try {
    const [following, followers] = await Promise.all([
      prisma.follow.findMany({
        where: { followerId: userId },
        include: { following: { include: { profile: { select: { avatar: true } } } } },
      }),
      prisma.follow.findMany({
        where: { followingId: userId },
        include: { follower: { include: { profile: { select: { avatar: true } } } } },
      }),
    ])
    const seen = new Set()
    const contacts = []
    const addUser = (u) => {
      if (!u || seen.has(u.id) || u.id === userId) return
      seen.add(u.id)
      contacts.push({
        id: u.id,
        pseudo: u.pseudo || null,
        firstName: u.firstName || null,
        lastName: u.lastName || null,
        role: u.role,
        profile: u.profile ? { avatar: u.profile.avatar || null } : null,
      })
    }
    following.forEach(f => addUser(f.following))
    followers.forEach(f => addUser(f.follower))
    res.json({ contacts })
  } catch (err) {
    console.error('GET /follow/contacts:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
