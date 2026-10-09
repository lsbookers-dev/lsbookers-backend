// routes/profile.js
const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { isOwnMediaUrl } = require('../lib/mediaUrl');
const { validate } = require('../middleware/validate');
const { profileUpdateSchema, accountUpdateSchema } = require('../schemas');

// Import fetch (CommonJS compatible)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const { isAdminUser } = require('../middleware/auth');
const isAdminRole = (role) => isAdminUser({ role });

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

// Moyenne et nombre d'avis vérifiés (laissés après une vraie prestation)
const reviewStats = async (profileId) => {
  const stats = await prisma.review.aggregate({
    where: { targetId: profileId, OR: [{ bookingId: { not: null } }, { staffId: { not: null } }] },
    _avg: { rating: true },
    _count: { rating: true },
  });
  return { reviewsAvg: stats._avg.rating ?? null, reviewsCount: stats._count.rating ?? 0 };
};

const toPublicProfile = (profile) => {
  const { user, _count, ...publicFields } = profile;
  const { _count: userCounts, ...userIdentity } = user;
  const showRealName = profile.showRealName === true;

  return {
    ...publicFields,
    user: {
      ...userIdentity,
      pseudo: showRealName ? null : user.pseudo,
      firstName: showRealName ? user.firstName : null,
      lastName: showRealName ? user.lastName : null,
    },
    followersCount: userCounts?.followers ?? 0,
    followingCount: userCounts?.following ?? 0,
  };
};

/**
 * GET /api/profile/me
 * Privé : profil complet de l'utilisateur connecté.
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({
      where: { userId: req.user.id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            pseudo: true,
            firstName: true,
            lastName: true,
            role: true,
            dateOfBirth: true,
            phone: true,
            countryOfResidence: true,
            _count: {
              select: {
                followers: true,
                following: true,
              },
            },
          },
        },
        notificationPreferences: true,
      },
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    res.set('Cache-Control', 'private, no-store');
    const { _count: userCounts, ...user } = profile.user;
    return res.json({
      profile: {
        ...profile,
        user,
        followersCount: userCounts.followers,
        followingCount: userCounts.following,
        ...(await reviewStats(profile.id)),
      },
    });
  } catch (error) {
    console.error('❌ Erreur récupération profil privé /me :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

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
    // SELECT explicite — seuls les champs destinés au profil public sont renvoyés.
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
        showRealName: true,
        soundcloudUrl: true,
        youtubeUrl: true,
        showSoundcloud: true,
        showStyles: true,
        showYoutubeUrl: true,
        instagramUrl: true,
        facebookUrl: true,
        tiktokUrl: true,
        twitterUrl: true,
        linkedinUrl: true,
        websiteUrl: true,
        cvText: true,
        feeInfo: true,
        radiusKm: true,
        typeEtablissement: true,
        // Coordonnées de la ville (géocodée), pas de l'adresse postale
        latitude: true,
        longitude: true,
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
      },
    });

    if (!profile || isAdminRole(profile?.user?.role)) {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    return res.json({
      profile: {
        ...toPublicProfile(profile),
        ...(await reviewStats(profile.id)),
      },
    });
  } catch (error) {
    console.error('❌ Erreur récupération profil public /user/:userId :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PUT /api/profile/me/account
 * Privé : informations saisies à l'inscription (identité, statut, SIRET…).
 * Ces données ne sont jamais affichées sur le profil public.
 */
router.put('/me/account', requireAuth, validate(accountUpdateSchema), async (req, res) => {
  const {
    pseudo, firstName, lastName, dateOfBirth, phone, countryOfResidence,
    legalStatus, organizerType, establishmentName, siret,
  } = req.body;
  const emptyToNull = (v) => (v === undefined ? undefined : (v || null));

  try {
    const current = await prisma.profile.findUnique({
      where: { userId: req.user.id },
      select: { id: true, legalStatus: true, siret: true },
    });
    if (!current) return res.status(404).json({ error: 'Profil introuvable' });

    if (pseudo !== undefined) {
      const taken = await prisma.user.findFirst({
        where: { pseudo: { equals: pseudo, mode: 'insensitive' }, NOT: { id: req.user.id } },
        select: { id: true },
      });
      if (taken) return res.status(409).json({ error: 'Ce pseudo est déjà utilisé' });
    }

    // SIRET vérifié dans le registre officiel pour une société (comme à l'inscription)
    const nextStatus = legalStatus !== undefined ? legalStatus : current.legalStatus;
    const nextSiret = siret !== undefined ? (siret || '').replace(/\s/g, '') : current.siret;
    if (siret !== undefined && nextStatus === 'COMPANY' && nextSiret && nextSiret !== current.siret) {
      if (!/^\d{14}$/.test(nextSiret)) {
        return res.status(400).json({ error: 'Format SIRET invalide — 14 chiffres requis' });
      }
      try {
        const siretRes = await fetch(
          `https://recherche-entreprises.api.gouv.fr/search?q=${nextSiret}&page=1&per_page=1`,
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
        );
        if (siretRes.ok) {
          const siretData = await siretRes.json();
          if (!siretData.total_results) {
            return res.status(400).json({ error: 'SIRET introuvable dans le registre officiel' });
          }
        }
        // API indisponible : on laisse passer (comme à l'inscription)
      } catch (siretErr) {
        console.warn('⚠️ Vérification SIRET impossible :', siretErr.message);
      }
    }

    const userData = {};
    if (pseudo !== undefined) userData.pseudo = pseudo;
    if (firstName !== undefined) userData.firstName = firstName;
    if (lastName !== undefined) userData.lastName = lastName;
    if (dateOfBirth !== undefined) userData.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;
    if (phone !== undefined) userData.phone = emptyToNull(phone);
    if (countryOfResidence !== undefined) userData.countryOfResidence = emptyToNull(countryOfResidence);

    const profileData = {};
    if (legalStatus !== undefined) profileData.legalStatus = legalStatus || null;
    if (organizerType !== undefined) profileData.organizerType = organizerType || null;
    if (establishmentName !== undefined) profileData.establishmentName = emptyToNull(establishmentName);
    if (siret !== undefined) profileData.siret = nextSiret || null;

    await prisma.$transaction([
      prisma.user.update({ where: { id: req.user.id }, data: userData }),
      prisma.profile.update({ where: { id: current.id }, data: profileData }),
    ]);

    return res.json({ ok: true });
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'Ce pseudo est déjà utilisé' });
    console.error('❌ Erreur mise à jour compte PUT /me/account :', error);
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

    if (profile.userId !== req.user.id && callerRole !== 'ADMIN') {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    res.set('Cache-Control', 'private, no-store');
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
    showStyles,
    youtubeUrl,
    showYoutubeUrl,
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
    showRealName,
    notificationPreferences,
  } = req.body;


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

    if (showStyles !== undefined) {
      dataToUpdate.showStyles = Boolean(showStyles);
    }

    if (sanitizeString(youtubeUrl) !== undefined) {
      dataToUpdate.youtubeUrl = sanitizeString(youtubeUrl);
    }

    if (showYoutubeUrl !== undefined) {
      dataToUpdate.showYoutubeUrl = Boolean(showYoutubeUrl);
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

    if (showRealName !== undefined) {
      dataToUpdate.showRealName = Boolean(showRealName);
    }

    // ✅ Médias (nouveaux champs prioritaires)
    if (sanitizedAvatar !== undefined) dataToUpdate.avatar = sanitizedAvatar;
    else if (sanitizedAvatarUrl !== undefined) dataToUpdate.avatar = sanitizedAvatarUrl;

    if (sanitizedBanner !== undefined) dataToUpdate.banner = sanitizedBanner;
    else if (sanitizedBannerUrl !== undefined) dataToUpdate.banner = sanitizedBannerUrl;

    // Avatar / bannière : uniquement des fichiers hébergés chez nous (ou valeur inchangée / vidée)
    for (const field of ['avatar', 'banner']) {
      const value = dataToUpdate[field];
      if (value && value !== profile[field] && !isOwnMediaUrl(value)) {
        return res.status(400).json({ error: 'URL média invalide' });
      }
    }

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

    return res.json({ profile: fullUpdatedProfile || updatedProfile });
  } catch (error) {
    console.error('❌ Erreur mise à jour profil PUT /:id :', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
