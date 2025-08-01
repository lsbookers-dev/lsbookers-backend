const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client') // Assure-toi que ce chemin est correct

// Récupération d’un utilisateur par ID
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