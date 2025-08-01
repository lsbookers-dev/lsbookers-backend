const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticate = require('../middleware/authenticate');

// ✅ Correctif : Import fetch compatible CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// ✅ Route publique : Récupérer le profil via userId
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const profile = await prisma.profile.findUnique({
      where: { userId: parseInt(userId) },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true }
        }
      }
    });

    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });

    res.json({ profile });
  } catch (error) {
    console.error('❌ Erreur récupération profil public /user/:userId :', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ Récupérer les événements d’un artiste via son userId
router.get('/calendar/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const profile = await prisma.profile.findUnique({
      where: { userId: parseInt(userId) }
    });

    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });

    const events = await prisma.event.findMany({
      where: { profileId: profile.id },
      orderBy: { date: 'asc' }
    });

    res.json({ events });
  } catch (error) {
    console.error('❌ Erreur récupération calendrier :', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ Récupérer le profil par ID interne (utilisateur connecté)
router.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const profile = await prisma.profile.findUnique({
      where: { id: parseInt(id) },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true }
        }
      }
    });

    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });

    res.json({ profile });
  } catch (error) {
    console.error('❌ Erreur récupération profil sécurisé /:id :', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ Mettre à jour un profil (ARTISTE ou ORGANIZER)
router.put('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const {
    bio,
    location,
    profession,
    radiusKm,
    specialties,
    typeEtablissement,
    latitude: clientLatitude,
    longitude: clientLongitude
  } = req.body;

  console.log('🟢 Données reçues PUT /profile/:id', req.body);

  try {
    const profile = await prisma.profile.findUnique({
      where: { id: parseInt(id) }
    });

    if (!profile || profile.userId !== userId) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    let latitude = profile.latitude;
    let longitude = profile.longitude;
    let country = profile.country;

    // 🌍 Si location est fournie : géocoder
    if (location) {
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(location)}`);
      const geoData = await geoRes.json();

      if (geoData.length > 0) {
        latitude = parseFloat(geoData[0].lat);
        longitude = parseFloat(geoData[0].lon);
        country = geoData[0].address?.country || null;
        console.log('📍 Coordonnées géocodées :', latitude, longitude, '🌐 Pays :', country);
      } else {
        return res.status(400).json({ error: 'Localisation invalide ou non reconnue' });
      }
    } else if (clientLatitude && clientLongitude) {
      latitude = clientLatitude;
      longitude = clientLongitude;

      // 🧭 Si on a les coordonnées mais pas le pays → géocoder inverse
      const revRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=3&addressdetails=1`);
      const revData = await revRes.json();
      country = revData?.address?.country || null;
      console.log('🌐 Pays déterminé par coordonnées :', country);
    }

    const updatedProfile = await prisma.profile.update({
      where: { id: parseInt(id) },
      data: {
        ...(bio !== undefined && { bio }),
        ...(profession !== undefined && { profession }),
        ...(location !== undefined && { location }),
        ...(radiusKm !== undefined && !isNaN(parseInt(radiusKm)) && { radiusKm: parseInt(radiusKm) }),
        ...(latitude !== undefined && { latitude }),
        ...(longitude !== undefined && { longitude }),
        ...(country !== undefined && { country }),
        ...(specialties !== undefined && { specialties }),
        ...(typeEtablissement !== undefined && { typeEtablissement })
      }
    });

    console.log('✅ Profil mis à jour avec succès');
    res.json({ profile: updatedProfile });
  } catch (error) {
    console.error('❌ Erreur mise à jour profil PUT /:id :', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;