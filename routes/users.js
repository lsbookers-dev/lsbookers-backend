const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const authenticateToken = require('../middleware/authenticateToken.js') // ✅ Correction ici

// ✅ Nouvelle route : GET /users → tous les utilisateurs sauf soi-même
router.get('/users', authenticateToken, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        id: {
          not: req.user.id, // exclure soi-même
        },
      },
      select: {
        id: true,
        name: true,
        role: true,
      },
    })

    res.json(users)
  } catch (err) {
    console.error('Erreur dans GET /users', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ✅ Route déjà en place : GET /users/:id
router.get('/users/:id', async (req, res) => {
  const userId = parseInt(req.params.id)

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

    res.json({ user })
  } catch (error) {
    console.error('Erreur dans GET /users/:id', error)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router