// routes/offers.js
const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const verifyToken = require('../middleware/verifytoken') // 🔐 Vérifie le token JWT

// 📌 Créer une nouvelle offre
router.post('/', verifyToken, async (req, res) => {
  const { title, description, type, date, location, country, radiusKm } = req.body

  // ✅ Vérification de base
  if (!title || !description || !type || !date || !location || !country) {
    return res.status(400).json({ error: 'CHAMPS_OBLIGATOIRES_MANQUANTS' })
  }

  try {
    // Vérifier que l’utilisateur est bien ORGANIZER
    if (req.user.role !== 'ORGANIZER') {
      return res.status(403).json({ error: 'ACCÈS_REFUSÉ (réservé aux organisateurs)' })
    }

    const profile = await prisma.profile.findUnique({
      where: { userId: req.user.id },
    })

    if (!profile) {
      return res.status(404).json({ error: 'PROFILE_INTROUVABLE' })
    }

    // 💾 Création de l’offre
    const offer = await prisma.offer.create({
      data: {
        title,
        description,
        type,
        date: new Date(date),
        location,
        country,
        radiusKm: radiusKm ? parseInt(radiusKm) : null,
        organizer: { connect: { id: profile.id } },
      },
    })

    return res.status(201).json(offer)
  } catch (error) {
    console.error('Erreur création offre :', error)
    return res.status(500).json({ error: 'ERREUR_SERVEUR' })
  }
})

module.exports = router