// routes/adminSettings.js
const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authenticate = require('../middleware/authenticate');

// --- Util: projection publique (pas d’infos sensibles) ---
function toPublicSettings(s) {
  if (!s) return null;
  return {
    mainColor: s.mainColor || '#111111',
    secondaryColor: s.secondaryColor || '#ffffff',
    welcomeText: s.welcomeText || '',
    bannerUrl: s.bannerUrl || '',

    // ✅ Nouveaux champs
    landingBgUrl: s.landingBgUrl || '',
    loginBgUrl: s.loginBgUrl || '',
    registerBgUrl: s.registerBgUrl || '',
    headerLogoUrl: s.headerLogoUrl || '',
  };
}

// --- GET /api/admin/settings (admin only) ---
router.get('/', authenticate, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    const s = await prisma.adminSettings.findFirst({
      orderBy: { id: 'asc' },
    });

    // s peut être null la 1ère fois
    return res.json(toPublicSettings(s) || toPublicSettings({}));
  } catch (e) {
    console.error('❌ [GET /admin/settings]', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// --- GET /api/admin/settings/public (public, lecture seule) ---
router.get('/public', async (_req, res) => {
  try {
    const s = await prisma.adminSettings.findFirst({
      orderBy: { id: 'asc' },
    });
    return res.json(toPublicSettings(s) || toPublicSettings({}));
  } catch (e) {
    console.error('❌ [GET /admin/settings/public]', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// --- PUT /api/admin/settings (admin only) ---
router.put('/', authenticate, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    const {
      mainColor,
      secondaryColor,
      welcomeText,
      bannerUrl,

      // ✅ Nouveaux champs
      landingBgUrl,
      loginBgUrl,
      registerBgUrl,
      headerLogoUrl,
    } = req.body || {};

    const data = {
      ...(mainColor !== undefined ? { mainColor } : {}),
      ...(secondaryColor !== undefined ? { secondaryColor } : {}),
      ...(welcomeText !== undefined ? { welcomeText } : {}),
      ...(bannerUrl !== undefined ? { bannerUrl } : {}),

      ...(landingBgUrl !== undefined ? { landingBgUrl } : {}),
      ...(loginBgUrl !== undefined ? { loginBgUrl } : {}),
      ...(registerBgUrl !== undefined ? { registerBgUrl } : {}),
      ...(headerLogoUrl !== undefined ? { headerLogoUrl } : {}),
    };

    // upsert: si aucun settings, on le crée
    const updated = await prisma.adminSettings.upsert({
      where: { id: 1 },
      update: data,
      create: { id: 1, ...data },
    });

    return res.json(toPublicSettings(updated));
  } catch (e) {
    console.error('❌ [PUT /admin/settings]', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;