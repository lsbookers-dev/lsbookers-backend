const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client') // ✅ CORRECTION ici
const prisma = new PrismaClient()
const authenticateToken = require('../middleware/authenticateToken')

// ✅ Nouvelle route : récupération de tous les utilisateurs
router.get('/users', authenticateToken, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        role: true,
      },
    })
    res.json(users)
  } catch (error) {
    console.error('Erreur dans GET /users', error)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ✅ Route déjà existante pour un utilisateur par ID
router.get('/users/:id', async (req, res) => {
  const userId = parseInt(req.params.id)
  if (isNaN(userId)) return res.status(400).json({ error: 'ID invalide' })

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
      },
    })

    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' })
    res.json({ user })
  } catch (error) {
    console.error('Erreur dans GET /users/:id', error)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router