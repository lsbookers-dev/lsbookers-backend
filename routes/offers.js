// routes/offers.js
const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const verifyToken = require('../middleware/verifyToken')

// 📌 Créer une nouvelle offre
router.post('/', verifyToken, async (req, res) => {
  const { title, description, type, date, location, country, radiusKm } = req.body

  // Vérification des champs obligatoires
  if (!title || !description || !type || !date || !location || !country) {
    return res.status(400).json({ error: 'CHAMPS_OBLIGATOIRES_MANQUANTS' })
  }

  try {
    // Vérifier que l’utilisateur est ORGANIZER
    if (req.user.role !== 'ORGANIZER') {
      return res.status(403).json({ error: 'ACCÈS_REFUSÉ (réservé aux organisateurs)' })
    }

    const profile = await prisma.profile.findUnique({
      where: { userId: req.user.id },
    })
    if (!profile) {
      return res.status(404).json({ error: 'PROFILE_INTROUVABLE' })
    }

    // Validation du type
    if (!['ARTIST', 'PROVIDER', 'ALL'].includes(type)) {
      return res.status(400).json({ error: 'TYPE_INVALIDE' })
    }

    // Validation de la date (doit être valide et dans le futur)
    const offerDate = new Date(date)
    if (isNaN(offerDate.getTime()) || offerDate <= new Date()) {
      return res.status(400).json({ error: 'DATE_INVALIDE_OU_PASSE' })
    }

    // Création de l’offre
    const offer = await prisma.offer.create({
      data: {
        title,
        description,
        type,
        date: offerDate,
        location,
        country,
        radiusKm: radiusKm ? parseInt(radiusKm) : null,
        status: 'ACTIVE',  // Par défaut ACTIVE
        organizer: { connect: { id: profile.id } },
      },
    })

    return res.status(201).json(offer)
  } catch (error) {
    console.error('Erreur création offre :', error)
    return res.status(500).json({ error: 'ERREUR_SERVEUR' })
  }
})

// 📌 Lister les offres avec filtres
router.get('/', async (req, res) => {
  const { type, location, country, organizerId } = req.query

  try {
    // Construire les filtres
    const where = {
      status: 'ACTIVE',  // Seulement les offres actives
    }

    if (type && ['ARTIST', 'PROVIDER', 'ALL'].includes(type)) {
      where.type = type
    }

    if (location) {
      where.location = {
        contains: location,
        mode: 'insensitive',
      }
    }

    if (country) {
      where.country = {
        contains: country,
        mode: 'insensitive',
      }
    }

    if (organizerId) {
      where.organizerId = parseInt(organizerId)
    }

    // Récupérer les offres
    const offers = await prisma.offer.findMany({
      where,
      include: {
        organizer: {
          include: {
            user: { select: { name: true } },  // Nom de l'organisateur
          },
        },
      },
      orderBy: {
        createdAt: 'desc',  // Plus récentes en premier
      },
    })

    return res.status(200).json(offers)
  } catch (error) {
    console.error('Erreur récupération offres :', error)
    return res.status(500).json({ error: 'ERREUR_SERVEUR' })
  }
})

// 📌 Récupérer une offre spécifique par ID
router.get('/:id', async (req, res) => {
  const { id } = req.params

  try {
    const offer = await prisma.offer.findUnique({
      where: { id: parseInt(id) },
      include: {
        organizer: {
          include: {
            user: { select: { name: true } },  // Nom de l'organisateur
          },
        },
      },
    })

    if (!offer || offer.status !== 'ACTIVE') {
      return res.status(404).json({ error: 'OFFRE_INTROUVABLE_OU_FERMEE' })
    }

    return res.status(200).json(offer)
  } catch (error) {
    console.error('Erreur récupération offre :', error)
    return res.status(500).json({ error: 'ERREUR_SERVEUR' })
  }
})

// 📌 Supprimer une offre
router.delete('/:id', verifyToken, async (req, res) => {
  const { id } = req.params

  try {
    // Vérifier que l’utilisateur est ORGANIZER
    if (req.user.role !== 'ORGANIZER') {
      return res.status(403).json({ error: 'ACCÈS_REFUSÉ (réservé aux organisateurs)' })
    }

    const profile = await prisma.profile.findUnique({
      where: { userId: req.user.id },
    })
    if (!profile) {
      return res.status(404).json({ error: 'PROFILE_INTROUVABLE' })
    }

    // Vérifier que l’offre existe et appartient à l’organisateur
    const offer = await prisma.offer.findUnique({
      where: { id: parseInt(id) },
    })
    if (!offer) {
      return res.status(404).json({ error: 'OFFRE_INTROUVABLE' })
    }
    if (offer.organizerId !== profile.id) {
      return res.status(403).json({ error: 'ACCÈS_REFUSÉ (non autorisé à supprimer cette offre)' })
    }

    // Supprimer l’offre
    await prisma.offer.delete({
      where: { id: parseInt(id) },
    })

    return res.status(204).json({})
  } catch (error) {
    console.error('Erreur suppression offre :', error)
    return res.status(500).json({ error: 'ERREUR_SERVEUR' })
  }
})

module.exports = router