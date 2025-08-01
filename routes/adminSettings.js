const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const authMiddleware = require('../middleware/authMiddleware')

// 🧠 Middleware de sécurité admin
const requireAdmin = async (req, res, next) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } })
  if (!user || !user.isAdmin) {
    return res.status(403).json({ error: 'Accès refusé ❌' })
  }
  next()
}

// 🔍 GET – Lire les paramètres de design actuels
router.get('/', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const settings = await prisma.adminSettings.findUnique({ where: { id: 1 } })

    if (!settings) {
      return res.status(404).json({ error: 'Paramètres introuvables' })
    }

    res.json(settings)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ✏️ PUT – Modifier les paramètres de design
router.put('/', authMiddleware, requireAdmin, async (req, res) => {
  const { mainColor, secondaryColor, bannerUrl, welcomeText } = req.body

  try {
    const updated = await prisma.adminSettings.upsert({
      where: { id: 1 },
      update: {
        mainColor,
        secondaryColor,
        bannerUrl,
        welcomeText
      },
      create: {
        id: 1,
        mainColor,
        secondaryColor,
        bannerUrl,
        welcomeText
      }
    })

    res.json({ message: 'Mise à jour réussie ✅', settings: updated })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router