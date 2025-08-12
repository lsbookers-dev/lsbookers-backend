const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticate = require('../middleware/authenticate');

// ✅ Import fetch compatible CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

/* ========================= Helpers ========================= */
function isBasicUpdate(body = {}) {
  const allowed = new Set(['bannerUrl', 'avatarUrl', 'description']);
  const keys = Object.keys(body);
  if (keys.length === 0) return false;
  // true si TOUTES les clés sont dans le set autorisé
  return keys.every((k) => allowed.has(k));
}

/* =================== Routes publiques (GET) =================== */

// ✅ Route publique : Récupérer le profil via userId
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const profile = await prisma.profile.findUnique({
      where: { userId: parseInt(userId, 10) },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
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
      where: { userId: parseInt(userId, 10) },
    });

    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });

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

// ✅ Récupérer le profil par ID interne (utilisateur connecté)
router.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const profile = await prisma.profile.findUnique({
      where: { id: parseInt(id, 10) },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });

    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });

    res.json({ profile });
  } catch (error) {
    console.error('❌ Erreur récupération profil sécurisé /:id :', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ============ Raccourci PUBLIC pour mise à jour basique ============ */
/**
 * Cette route capte PUT /:id quand la requête ne contient QUE
 * bannerUrl / avatarUrl / description (rien d’autre).
 * Elle met à jour directement le profil SANS authentification.
 * ⚠️ À sécuriser plus tard (token) quand on branchera le front auth complet.
 */
router.put('/:id', async (req, res, next) => {
  try {
    if (!isBasicUpdate(req.body)) {
      // Ce n'est pas une mise à jour "basique" → on laisse la route suivante gérer (auth requise)
      return next();
    }

    const { id } = req.params;
    const { bannerUrl, avatarUrl, description } = req.body || {};

    const updated = await prisma.profile.update({
      where: { id: parseInt(id, 10) },
      data: {
        ...(bannerUrl !== undefined && { bannerUrl }),
        ...(avatarUrl !== undefined && { avatarUrl }),
        // on stocke "description" dans la colonne bio
        ...(description !== undefined && { bio: description }),
      },
      select: {
        id: true,
        bannerUrl: true,
        avatarUrl: true,
        bio: true,
      },
    });

    return res.json({ ok: true, profile: updated });
  } catch (error) {
    console.error('❌ Erreur mise à jour basique (publique) PUT /:id :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ===================== Route sécurisée (complète) ===================== */

// ✅ Mettre à jour un profil (complète, avec auth)
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
    longitude: clientLongitude,
    avatarUrl,
    bannerUrl,
  } = req.body;

  console.log('🟢 Données reçues PUT /profile/:id', req.body);

  try {
    const profile = await prisma.profile.findUnique({
      where: { id: parseInt(id, 10) },
    });

    if (!profile || profile.userId !== userId) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    let latitude = profile.latitude;
    let longitude = profile.longitude;
    let country = profile.country;

    // 🌍 Si location est fournie : géocoder
    if (location) {
      const geoRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(
          location
        )}`
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
    } else if (clientLatitude && clientLongitude) {
      latitude = clientLatitude;
      longitude = clientLongitude;

      const revRes = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=3&addressdetails=1`
      );
      const revData = await revRes.json();
      country = revData?.address?.country || null;
      console.log('🌐 Pays déterminé par coordonnées :', country);
    }

    const updatedProfile = await prisma.profile.update({
      where: { id: parseInt(id, 10) },
      data: {
        ...(bio !== undefined && { bio }),
        ...(profession !== undefined && { profession }),
        ...(location !== undefined && { location }),
        ...(radiusKm !== undefined &&
          !isNaN(parseInt(radiusKm, 10)) && { radiusKm: parseInt(radiusKm, 10) }),
        ...(latitude !== undefined && { latitude }),
        ...(longitude !== undefined && { longitude }),
        ...(country !== undefined && { country }),
        ...(specialties !== undefined && { specialties }),
        ...(typeEtablissement !== undefined && { typeEtablissement }),
        ...(avatarUrl !== undefined && { avatarUrl }),
        ...(bannerUrl !== undefined && { bannerUrl }),
      },
    });

    console.log('✅ Profil mis à jour avec succès');
    res.json({ profile: updatedProfile });
  } catch (error) {
    console.error('❌ Erreur mise à jour profil PUT /:id :', error?.message || error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;