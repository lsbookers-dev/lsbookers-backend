// routes/profile.js
const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticate = require('../middleware/authenticate');

// Import fetch (CommonJS compatible)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const isAdminRole = (role) => String(role || '').toUpperCase() === 'ADMIN';

/**
 * GET /api/profile/user/:userId
 * Public : récupérer un profil par userId
 * 👉 Invisibilité ADMIN : si le profil appartient à un ADMIN, on renvoie 404
 */
router.get('/user/:userId', async (req, res) => {
  const raw = req.params.userId;
  const userId = Number.parseInt(raw, 10);
  if (Number.isNaN(userId)) {
    return res.status(400).json({ error: 'Paramètre userId invalide' });
  }

  try {
    const profile = await prisma.profile.findUnique({
      where: { userId },
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
      },
    });

    if (!profile || isAdminRole(profile?.user?.role)) {
      // ADMIN invisible sur les pages publiques
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    res.json({ profile });
  } catch (error) {
    console.error('❌ Erreur récupération profil public /user/:userId :', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/profile/calendar/:userId
 * Public : calendrier d’un artiste (via userId)
 * 👉 Invisibilité ADMIN : 404 si le profil est ADMIN
 */
router.get('/calendar/:userId', async (req, res) => {
  const raw = req.params.userId;
  const userId = Number.parseInt(raw, 10);
  if (Number.isNaN(userId)) {
    return res.status(400).json({ error: 'Paramètre userId invalide' });
  }

  try {
    // On inclut l'user pour tester le rôle
    const profile = await prisma.profile.findUnique({
      where: { userId },
      include: {
        user: { select: { id: true, role: true } },
      },
    });
    if (!profile || isAdminRole(profile?.user?.role)) {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    const events = await prisma.event.findMany({
      where: { profileId: profile.id },
      orderBy: { date: 'asc' },
    });

    res.json({ events });
  } catch (error) {
    console.error('❌ Erreur récupération calendrier :', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/profile/:id
 * Privé : récupérer un profil par id interne
 * 👉 Invisibilité ADMIN sur privé aussi si l’appelant n’est pas ADMIN
 */
router.get('/:id', authenticate, async (req, res) => {
  const raw = req.params.id;
  const id = Number.parseInt(raw, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'Paramètre id invalide' });
  }

  try {
    const profile = await prisma.profile.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
      },
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    // Si le profil appartient à un ADMIN et que l’appelant n’est pas ADMIN → 404 (invisible)
    const callerRole = String(req.user?.role || '').toUpperCase();
    if (isAdminRole(profile.user?.role) && callerRole !== 'ADMIN') {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    res.json({ profile });
  } catch (error) {
    console.error('❌ Erreur récupération profil sécurisé /:id :', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PUT /api/profile/:id
 * Privé : mettre à jour le profil
 * NOTE : on accepte avatar/banner ET avatarUrl/bannerUrl (alias).
 */
router.put('/:id', authenticate, async (req, res) => {
  const raw = req.params.id;
  const id = Number.parseInt(raw, 10);
  const userId = req.user.id;

  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'Paramètre id invalide' });
  }

  // Champs possibles en entrée
  const {
    bio,
    location,
    profession,
    radiusKm,
    specialties,
    typeEtablissement,
    latitude: clientLatitude,
    longitude: clientLongitude,

    // Nouveaux champs (col. Prisma)
    avatar,
    banner,

    // Aliases historiques acceptés
    avatarUrl,
    bannerUrl,
  } = req.body;

  console.log('🟢 Données reçues PUT /profile/:id', req.body);

  try {
    const profile = await prisma.profile.findUnique({
      where: { id },
      include: { user: { select: { role: true, id: true } } },
    });

    if (!profile || profile.userId !== userId) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    let latitude = profile.latitude;
    let longitude = profile.longitude;
    let country = profile.country;

    // 🌍 Géocodage si "location" fourni
    if (location) {
      const geoRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(location)}`
      );
      const geoData = await geoRes.json();

      if (Array.isArray(geoData) && geoData.length > 0) {
        latitude = parseFloat(geoData[0].lat);
        longitude = parseFloat(geoData[0].lon);
        country = geoData[0].address?.country || null;
        console.log('📍 Coordonnées géocodées :', latitude, longitude, '🌐 Pays :', country);
      } else {
        return res.status(400).json({ error: 'Localisation invalide ou non reconnue' });
      }
    } else if (clientLatitude != null && clientLongitude != null) {
      latitude = Number(clientLatitude);
      longitude = Number(clientLongitude);

      const revRes = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=3&addressdetails=1`
      );
      const revData = await revRes.json();
      country = revData?.address?.country || null;
      console.log('🌐 Pays déterminé par coordonnées :', country);
    }

    // Prépare le payload de mise à jour
    const dataToUpdate = {};

    if (bio !== undefined) dataToUpdate.bio = bio;
    if (profession !== undefined) dataToUpdate.profession = profession;
    if (location !== undefined) dataToUpdate.location = location;
    if (radiusKm !== undefined && !Number.isNaN(Number.parseInt(radiusKm, 10))) {
      dataToUpdate.radiusKm = Number.parseInt(radiusKm, 10);
    }
    if (latitude !== undefined) dataToUpdate.latitude = latitude;
    if (longitude !== undefined) dataToUpdate.longitude = longitude;
    if (country !== undefined) dataToUpdate.country = country;
    if (specialties !== undefined) dataToUpdate.specialties = specialties;
    if (typeEtablissement !== undefined) dataToUpdate.typeEtablissement = typeEtablissement;

    // ✅ Médias (nouveaux champs prioritaires)
    if (avatar !== undefined) dataToUpdate.avatar = avatar;
    else if (avatarUrl !== undefined) dataToUpdate.avatar = avatarUrl;

    if (banner !== undefined) dataToUpdate.banner = banner;
    else if (bannerUrl !== undefined) dataToUpdate.banner = bannerUrl;

    const updatedProfile = await prisma.profile.update({
      where: { id },
      data: dataToUpdate,
    });

    console.log('✅ Profil mis à jour avec succès');
    res.json({ profile: updatedProfile });
  } catch (error) {
    console.error('❌ Erreur mise à jour profil PUT /:id :', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;