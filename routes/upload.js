// routes/upload.js — Cloudflare R2 (remplace Vercel Blob)
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { r2Client, R2_BUCKET, R2_PUBLIC_URL } = require('../lib/r2');
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

// Limite globale à 100 Mo (vidéo). La validation par type est faite dans la route.
const IMAGE_MAX_SIZE = 25 * 1024 * 1024;  // 25 Mo pour les images
const VIDEO_MAX_SIZE = 100 * 1024 * 1024; // 100 Mo pour les vidéos

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: VIDEO_MAX_SIZE },
});

/* ----------------------------- Helpers ----------------------------------- */
function mapMulterError(err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return { status: 413, payload: { error: 'FILE_TOO_LARGE', max: '100MB (vidéo) / 25MB (image)' } };
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
  if (!mimetype.startsWith('image/')) return true;
  if (buf.length < 12) return false;

  if (mimetype === 'image/jpeg')
    return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;

  if (mimetype === 'image/png')
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;

  if (mimetype === 'image/gif')
    return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;

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

      // Validation taille par type : images ≤ 25 Mo, vidéos ≤ 100 Mo
      const isImage = req.file.mimetype.startsWith('image/');
      const maxSize = isImage ? IMAGE_MAX_SIZE : VIDEO_MAX_SIZE;
      if (req.file.size > maxSize) {
        const maxLabel = isImage ? '25MB' : '100MB';
        return res.status(413).json({ error: 'FILE_TOO_LARGE', max: maxLabel });
      }

      // Validation magic bytes pour les images (anti-spoofing)
      if (!isValidImageBuffer(req.file.buffer, req.file.mimetype)) {
        console.warn(`⚠️ Magic bytes invalides pour ${req.file.originalname} (${req.file.mimetype})`);
        return res.status(400).json({ error: 'FORMAT_NOT_ALLOWED' });
      }

      // Validation du dossier de destination (allowlist)
      const rawFolder = req.body.folder || 'media';
      const folder = ALLOWED_FOLDERS.has(rawFolder) ? rawFolder : 'media';

      const key = `lsbookers/${folder}/${Date.now()}-${sanitizeName(req.file.originalname)}`;

      // Upload vers Cloudflare R2
      await r2Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ContentLength: req.file.size,
        CacheControl: 'public, max-age=31536000, immutable',
      }));

      const url = `${R2_PUBLIC_URL}/${key}`;
      console.log('✅ R2 upload OK:', url);

      return res.json({
        url,
        pathname: key,
        contentType: req.file.mimetype,
        size: req.file.size,
      });
    } catch (e) {
      console.error('❌ Upload route error:', e);
      return res.status(500).json({ error: 'SERVER_ERROR', details: e.message });
    }
  });
});

module.exports = router;
