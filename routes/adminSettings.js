// routes/adminSettings.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');

/** Vérifie ADMIN */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  }
  next();
}

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'site-settings.json');

const DEFAULT_SETTINGS = {
  welcomeText: '',
  landingBgUrl: '',
  loginBgUrl: '',
  registerBgUrl: '',
  headerLogoUrl: '',
};

/** S’assure que le fichier existe */
function ensureFile() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
  }
}

/** Lecture synchrone (petit fichier) */
function readSettings() {
  ensureFile();
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...(data || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Écriture synchrone (petit fichier) */
function writeSettings(next) {
  ensureFile();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
}

/* ==========================================
 * GET /api/admin/settings
 * ======================================== */
router.get('/', requireAuth, requireAdmin, (_req, res) => {
  try {
    const data = readSettings();
    return res.json(data);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ GET settings', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ==========================================
 * PUT /api/admin/settings
 * body: { welcomeText?, landingBgUrl?, loginBgUrl?, registerBgUrl?, headerLogoUrl? }
 * ======================================== */
router.put('/', requireAuth, requireAdmin, (req, res) => {
  try {
    const current = readSettings();

    // Sécurise les champs (string uniquement)
    const next = {
      welcomeText: typeof req.body?.welcomeText === 'string' ? req.body.welcomeText : current.welcomeText,
      landingBgUrl: typeof req.body?.landingBgUrl === 'string' ? req.body.landingBgUrl : current.landingBgUrl,
      loginBgUrl: typeof req.body?.loginBgUrl === 'string' ? req.body.loginBgUrl : current.loginBgUrl,
      registerBgUrl: typeof req.body?.registerBgUrl === 'string' ? req.body.registerBgUrl : current.registerBgUrl,
      headerLogoUrl: typeof req.body?.headerLogoUrl === 'string' ? req.body.headerLogoUrl : current.headerLogoUrl,
    };

    writeSettings(next);
    return res.json(next);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ PUT settings', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;