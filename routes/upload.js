// routes/upload.js — Vercel Blob (remplace Cloudinary)
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { put } = require('@vercel/blob');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');

/* -------------------- Rate limiter uploads -------------------- */
// Max 30 uploads par IP par heure (protection stockage + abus)
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop d\'uploads, réessayez dans 1 heure' },
});

/* --------------------------- Multer configuration ------------------------ */
const storage = multer.memoryStorage();

const ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/ogg',
];

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
  return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'FORMAT_NOT_ALLOWED'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 Mo
});

/* ----------------------------- Helpers ----------------------------------- */
function mapMulterError(err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return { status: 413, payload: { error: 'FILE_TOO_LARGE', max: '100MB' } };
    if (err.code === 'LIMIT_UNEXPECTED_FILE')
      return { status: 400, payload: { error: 'FORMAT_NOT_ALLOWED' } };
    return { status: 400, payload: { error: 'MULTER_ERROR', code: err.code } };
  }
  return { status: 500, payload: { error: 'UPLOAD_MIDDLEWARE_ERROR' } };
}

function sanitizeName(name) {
  return (name || 'file').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
}

/**
 * Vérifie les magic bytes du fichier pour les images.
 * Évite le spoofing de MIME type (ex: un HTML déguisé en JPEG).
 * Les vidéos ne sont pas vérifiées car les formats sont trop variés.
 */
function isValidImageBuffer(buf, mimetype) {
  // Pour les vidéos, on fait confiance au fileFilter multer
  if (!mimetype.startsWith('image/')) return true;
  if (buf.length < 12) return false;

  // JPEG: FF D8 FF
  if (mimetype === 'image/jpeg')
    return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;

  // PNG: 89 50 4E 47 (‰PNG)
  if (mimetype === 'image/png')
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;

  // GIF: 47 49 46 38 (GIF8)
  if (mimetype === 'image/gif')
    return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;

  // WebP: RIFF....WEBP
  if (mimetype === 'image/webp')
    return buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
           buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;

  return false;
}

// Dossiers autorisés — évite path traversal ou stockage dans des dossiers arbitraires
const ALLOWED_FOLDERS = new Set(['avatars', 'banners', 'media', 'documents', 'logos']);

/* ------------------------------ Route ------------------------------------ */
// POST /api/upload
// Requiert d'être connecté (requireAuth) + rate limited
// FormData attendu : file=<Blob>, folder?=avatars|banners|media|documents|logos
router.post('/', requireAuth, uploadLimiter, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const { status, payload } = mapMulterError(err);
      console.error('❌ Multer error:', err);
      return res.status(status).json(payload);
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'NO_FILE' });
      }

      // Validation magic bytes pour les images (anti-spoofing)
      if (!isValidImageBuffer(req.file.buffer, req.file.mimetype)) {
        console.warn(`⚠️ Magic bytes invalides pour ${req.file.originalname} (${req.file.mimetype})`);
        return res.status(400).json({ error: 'FORMAT_NOT_ALLOWED' });
      }

      // Validation du dossier de destination (allowlist)
      const rawFolder = req.body.folder || 'media';
      const folder = ALLOWED_FOLDERS.has(rawFolder) ? rawFolder : 'media';

      const filename = `lsbookers/${folder}/${Date.now()}-${sanitizeName(req.file.originalname)}`;

      const blob = await put(filename, req.file.buffer, {
        access: 'public',
        contentType: req.file.mimetype,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });

      console.log('✅ Vercel Blob upload OK:', blob.url);

      return res.json({
        url: blob.url,
        pathname: blob.pathname,
        contentType: blob.contentType,
        size: req.file.size,
      });
    } catch (e) {
      console.error('❌ Upload route error:', e);
      return res.status(500).json({ error: 'SERVER_ERROR', details: e.message });
    }
  });
});

module.exports = router;
