const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')

/* =========================================================
   GET /api/users
   ➜ tous les utilisateurs sauf soi-même, avec avatar profil
========================================================= */
router.get('/users', requireAuth, async (req, res) => {
  try {
    const currentUserId = Number(req.user?.id)

    const users = await prisma.user.findMany({
      where: {
        id: {
          not: currentUserId,
        },
        role: {
          not: 'ADMIN',
        },
      },
      select: {
        id: true,
        name: true,
        role: true,
        profile: {
          select: {
            avatar: true,
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    })

    return res.json({ users })
  } catch (err) {
    console.error('Erreur dans GET /users', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

/* =========================================================
   GET /api/users/:id
========================================================= */
router.get('/users/:id', async (req, res) => {
  const userId = parseInt(req.params.id, 10)

  if (isNaN(userId)) {
    return res.status(400).json({ error: 'ID invalide' })
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
      },
    })

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' })
    }

    return res.json({ user })
  } catch (error) {
    console.error('Erreur dans GET /users/:id', error)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router