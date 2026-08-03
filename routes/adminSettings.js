// routes/adminSettings.js
// Les paramètres sont stockés en base de données (PostgreSQL via Prisma)
// et non plus dans un fichier JSON (qui disparaît à chaque redémarrage Railway).

const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { adminSettingsUpdateSchema } = require('../schemas');

/** Vérifie ADMIN */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  }
  next();
}

/** Récupère (ou crée) la ligne de settings unique (id = 1) */
async function getOrCreateSettings() {
  let settings = await prisma.adminSettings.findUnique({ where: { id: 1 } });
  if (!settings) {
    settings = await prisma.adminSettings.create({
      data: { id: 1 },
    });
  }
  return settings;
}

/* ==========================================
 * GET /api/admin/settings  (public — pour les pages login/landing/register)
 * ======================================== */
router.get('/', async (_req, res) => {
  try {
    const settings = await getOrCreateSettings();
    return res.json({
      welcomeText:    settings.welcomeText    || '',
      landingBgUrl:   settings.landingBgUrl   || '',
      loginBgUrl:     settings.loginBgUrl     || '',
      registerBgUrl:  settings.registerBgUrl  || '',
      headerLogoUrl:  settings.headerLogoUrl  || '',
      mainColor:      settings.mainColor      || '#FF0055',
      secondaryColor: settings.secondaryColor || '#000000',
      bannerUrl:      settings.bannerUrl      || '',
      logoUrl:        settings.logoUrl        || '',
    });
  } catch (err) {
    console.error('❌ GET settings', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ==========================================
 * PUT /api/admin/settings  (admin uniquement)
 * body: { welcomeText?, landingBgUrl?, loginBgUrl?, registerBgUrl?, headerLogoUrl?, ... }
 * Seuls les champs envoyés sont mis à jour (merge partiel)
 * ======================================== */
router.put('/', requireAuth, requireAdmin, validate(adminSettingsUpdateSchema), async (req, res) => {
  try {
    // Zod a déjà validé et nettoyé req.body — on ne garde que les champs présents
    const data = {};
    const fields = [
      'welcomeText', 'landingBgUrl', 'loginBgUrl', 'registerBgUrl',
      'headerLogoUrl', 'mainColor', 'secondaryColor', 'bannerUrl', 'logoUrl',
    ];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        data[field] = req.body[field];
      }
    }

    const updated = await prisma.adminSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...data },
      update: data,
    });

    return res.json({
      welcomeText:    updated.welcomeText    || '',
      landingBgUrl:   updated.landingBgUrl   || '',
      loginBgUrl:     updated.loginBgUrl     || '',
      registerBgUrl:  updated.registerBgUrl  || '',
      headerLogoUrl:  updated.headerLogoUrl  || '',
      mainColor:      updated.mainColor      || '#FF0055',
      secondaryColor: updated.secondaryColor || '#000000',
      bannerUrl:      updated.bannerUrl      || '',
      logoUrl:        updated.logoUrl        || '',
    });
  } catch (err) {
    console.error('❌ PUT settings', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
