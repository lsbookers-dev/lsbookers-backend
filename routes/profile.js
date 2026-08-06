// routes/profile.js
const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { profileUpdateSchema } = require('../schemas');

// Import fetch (CommonJS compatible)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const isAdminRole = (role) => String(role || '').toUpperCase() === 'ADMIN';

const parseIntegerOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const parseFloatOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const sanitizeString = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return String(value);
  return value.trim();
};

const sanitizeStringArray = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) return undefined;

  return value
    .map((item) => (typeof item === 'string' ? item.trim() : String(item).trim()))
    .filter((item) => item.length > 0);
};

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
    // SELECT explicite — seuls les champs publics sont renvoyés
    // Les champs confidentiels (siret, address, postalCode, city, legalStatus,
    // organizerType, establishmentName, notificationPreferences, user.email)
    // sont volontairement exclus.
    const profile = await prisma.profile.findUnique({
      where: { userId },
      select: {
        id: true,
        userId: true,
        bio: true,
        location: true,
        country: true,
        avatar: true,
        banner: true,
        profession: true,
        specialties: true,
        styles: true,
        availableForBooking: true,
        showRealName: true,
        soundcloudUrl: true,
        youtubeUrl: true,
        showSoundcloud: true,
        instagramUrl: true,
        facebookUrl: true,
        tiktokUrl: true,
        twitterUrl: true,
        linkedinUrl: true,
        websiteUrl: true,
        address: true,
        postalCode: true,
        city: true,
        cvText: true,
        feeInfo: true,
        latitude: true,
        longitude: true,
        radiusKm: true,
        typeEtablissement: true,
        user: {
          select: {
            id: true,
            pseudo: true,
            firstName: true,
            lastName: true,
            role: true,
            // email intentionnellement exclu (donnée privée)
            _count: { select: { followers: true, following: true } },
          },
        },
        _count: { select: { reviewsReceived: true } },
      },
    });

    if (!profile || isAdminRole(profile?.user?.role)) {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    // Moyenne des avis
    const reviews = await prisma.review.aggregate({
      where: { targetId: profile.id },
      _avg: { rating: true },
      _count: { rating: true },
    });

    return res.json({
      profile: {
        ...profile,
        followersCount: profile.user?._count?.followers ?? 0,
        followingCount: profile.user?._count?.following ?? 0,
        reviewsAvg: reviews._avg.rating ?? null,
        reviewsCount: reviews._count.rating ?? 0,
      },
    });
  } catch (error) {
    console.error('❌ Erreur récupération profil public /user/:userId :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/profile/calendar/:userId
 * Public : calendrier d’un profil (via userId)
 * 👉 Invisibilité ADMIN : 404 si le profil est ADMIN
 */
router.get('/calendar/:userId', async (req, res) => {
  const raw = req.params.userId;
  const userId = Number.parseInt(raw, 10);

  if (Number.isNaN(userId)) {
    return res.status(400).json({ error: 'Paramètre userId invalide' });
  }

  try {
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
      orderBy: { start: 'asc' },
    });

    return res.json({ events });
  } catch (error) {
    console.error('❌ Erreur récupération calendrier :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/profile/:id
 * Privé : récupérer un profil par id interne
 * 👉 Invisibilité ADMIN sur privé aussi si l’appelant n’est pas ADMIN
 */
router.get('/:id', requireAuth, async (req, res) => {
  const raw = req.params.id;
  const id = Number.parseInt(raw, 10);

  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'Paramètre id invalide' });
  }

  try {
    const profile = await prisma.profile.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, pseudo: true, firstName: true, lastName: true, email: true, role: true } },
        notificationPreferences: true,
      },
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    const callerRole = String(req.user?.role || '').toUpperCase();
    if (isAdminRole(profile.user?.role) && callerRole !== 'ADMIN') {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    return res.json({ profile });
  } catch (error) {
    console.error('❌ Erreur récupération profil sécurisé /:id :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PUT /api/profile/:id
 * Privé : mettre à jour le profil
 * NOTE : on accepte avatar/banner ET avatarUrl/bannerUrl (alias).
 * Version V1 robuste, compatible avec le frontend actuel.
 */
router.put('/:id', requireAuth, validate(profileUpdateSchema), async (req, res) => {
  const raw = req.params.id;
  const id = Number.parseInt(raw, 10);
  const userId = req.user.id;

  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'Paramètre id invalide' });
  }

  const {
    bio,
    location,
    profession,
    radiusKm,
    specialties,
    typeEtablissement,
    latitude: clientLatitude,
    longitude: clientLongitude,
    country: clientCountry,
    avatar,
    banner,
    avatarUrl,
    bannerUrl,
    soundcloudUrl,
    showSoundcloud,
    youtubeUrl,
    instagramUrl,
    facebookUrl,
    tiktokUrl,
    twitterUrl,
    linkedinUrl,
    websiteUrl,
    address,
    postalCode,
    city,
    cvText,
    feeInfo,
    styles,
    availableForBooking,
    showRealName,
    notificationPreferences,
  } = req.body;

  console.log('🟢 Données reçues PUT /profile/:id', req.body);

  try {
    const profile = await prisma.profile.findUnique({
      where: { id },
      include: {
        user: { select: { role: true, id: true } },
      },
    });

    if (!profile || profile.userId !== userId) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    let latitude = profile.latitude;
    let longitude = profile.longitude;
    let country = profile.country;

    const sanitizedLocation = sanitizeString(location);
    const sanitizedBio = sanitizeString(bio);
    const sanitizedProfession = sanitizeString(profession);
    const sanitizedTypeEtablissement = sanitizeString(typeEtablissement);
    const sanitizedAvatar = sanitizeString(avatar);
    const sanitizedBanner = sanitizeString(banner);
    const sanitizedAvatarUrl = sanitizeString(avatarUrl);
    const sanitizedBannerUrl = sanitizeString(bannerUrl);
    const sanitizedCountry = sanitizeString(clientCountry);
    const sanitizedSoundcloudUrl = sanitizeString(soundcloudUrl);

    const parsedRadiusKm = parseIntegerOrNull(radiusKm);
    const parsedClientLatitude = parseFloatOrNull(clientLatitude);
    const parsedClientLongitude = parseFloatOrNull(clientLongitude);
    const sanitizedSpecialties = sanitizeStringArray(specialties);

    // 🌍 Géocodage si "location" fourni
    const NOMINATIM_HEADERS = {
      'User-Agent': 'LSBookers/1.0 (contact@lsbookers.com)',
      'Accept-Language': 'fr',
    };

    const fetchWithTimeout = (url, options = {}, timeoutMs = 5000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
    };

    if (sanitizedLocation) {
      try {
        const geoRes = await fetchWithTimeout(
          `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(sanitizedLocation)}`,
          { headers: NOMINATIM_HEADERS },
          5000
        );
        const geoData = await geoRes.json();

        if (Array.isArray(geoData) && geoData.length > 0) {
          latitude = parseFloat(geoData[0].lat);
          longitude = parseFloat(geoData[0].lon);
          country = geoData[0].address?.country || sanitizedCountry || null;
          console.log('📍 Coordonnées géocodées :', latitude, longitude, '🌐 Pays :', country);
        } else {
          // Géocodage sans résultat — on sauvegarde quand même la ville telle quelle
          console.warn('⚠️ Géocodage sans résultat pour :', sanitizedLocation);
          country = sanitizedCountry || profile.country || null;
        }
      } catch (geoError) {
        // Timeout ou erreur réseau — on sauvegarde quand même sans coordonnées
        console.warn('⚠️ Géocodage impossible :', geoError.message);
        country = sanitizedCountry || profile.country || null;
      }
    } else if (parsedClientLatitude !== null && parsedClientLongitude !== null) {
      latitude = parsedClientLatitude;
      longitude = parsedClientLongitude;

      try {
        const revRes = await fetchWithTimeout(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=3&addressdetails=1`,
          { headers: NOMINATIM_HEADERS },
          5000
        );
        const revData = await revRes.json();
        country = sanitizedCountry || revData?.address?.country || profile.country || null;
        console.log('🌐 Pays déterminé par coordonnées :', country);
      } catch (reverseError) {
        console.warn('⚠️ Reverse geocoding impossible :', reverseError.message);
        country = sanitizedCountry || profile.country || null;
      }
    } else if (sanitizedCountry !== undefined) {
      country = sanitizedCountry;
    }

    const dataToUpdate = {};

    if (sanitizedBio !== undefined) dataToUpdate.bio = sanitizedBio;
    if (sanitizedProfession !== undefined) dataToUpdate.profession = sanitizedProfession;
    if (sanitizedLocation !== undefined) dataToUpdate.location = sanitizedLocation;

    if (parsedRadiusKm !== null || radiusKm === null || radiusKm === '') {
      dataToUpdate.radiusKm = parsedRadiusKm;
    }

    if (latitude !== undefined) dataToUpdate.latitude = latitude;
    if (longitude !== undefined) dataToUpdate.longitude = longitude;
    if (country !== undefined) dataToUpdate.country = country;

    if (sanitizedSpecialties !== undefined) {
      dataToUpdate.specialties = sanitizedSpecialties;
    }

    if (sanitizedTypeEtablissement !== undefined) {
      dataToUpdate.typeEtablissement = sanitizedTypeEtablissement;
    }

    if (sanitizedSoundcloudUrl !== undefined) {
      dataToUpdate.soundcloudUrl = sanitizedSoundcloudUrl;
    }

    if (showSoundcloud !== undefined) {
      dataToUpdate.showSoundcloud = Boolean(showSoundcloud);
    }

    if (sanitizeString(youtubeUrl) !== undefined) {
      dataToUpdate.youtubeUrl = sanitizeString(youtubeUrl);
    }

    const socialFields = { instagramUrl, facebookUrl, tiktokUrl, twitterUrl, linkedinUrl, websiteUrl };
    for (const [key, val] of Object.entries(socialFields)) {
      const s = sanitizeString(val);
      if (s !== undefined) dataToUpdate[key] = s;
    }

    if (sanitizeString(address) !== undefined) dataToUpdate.address = sanitizeString(address);
    if (sanitizeString(postalCode) !== undefined) dataToUpdate.postalCode = sanitizeString(postalCode);
    if (sanitizeString(city) !== undefined) dataToUpdate.city = sanitizeString(city);
    if (sanitizeString(cvText) !== undefined) dataToUpdate.cvText = sanitizeString(cvText);
    if (sanitizeString(feeInfo) !== undefined) dataToUpdate.feeInfo = sanitizeString(feeInfo);

    const sanitizedStyles = sanitizeStringArray(styles);
    if (sanitizedStyles !== undefined) {
      dataToUpdate.styles = sanitizedStyles;
    }

    if (availableForBooking !== undefined) {
      dataToUpdate.availableForBooking = Boolean(availableForBooking);
    }

    if (showRealName !== undefined) {
      dataToUpdate.showRealName = Boolean(showRealName);
    }

    // ✅ Médias (nouveaux champs prioritaires)
    if (sanitizedAvatar !== undefined) dataToUpdate.avatar = sanitizedAvatar;
    else if (sanitizedAvatarUrl !== undefined) dataToUpdate.avatar = sanitizedAvatarUrl;

    if (sanitizedBanner !== undefined) dataToUpdate.banner = sanitizedBanner;
    else if (sanitizedBannerUrl !== undefined) dataToUpdate.banner = sanitizedBannerUrl;

    const updatedProfile = await prisma.profile.update({
      where: { id },
      data: dataToUpdate,
    });

    if (notificationPreferences?.locationScope) {
      await prisma.notificationPreferences.upsert({
        where: { profileId: profile.id },
        update: {
          locationScope: String(notificationPreferences.locationScope),
        },
        create: {
          profileId: profile.id,
          locationScope: String(notificationPreferences.locationScope),
        },
      });
    }

    const fullUpdatedProfile = await prisma.profile.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, pseudo: true, firstName: true, lastName: true, email: true, role: true } },
        notificationPreferences: true,
      },
    });

    console.log('✅ Profil mis à jour avec succès');
    return res.json({ profile: fullUpdatedProfile || updatedProfile });
  } catch (error) {
    console.error('❌ Erreur mise à jour profil PUT /:id :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;