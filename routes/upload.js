// routes/upload.js — Cloudflare R2 (remplace Vercel Blob)
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { r2Client, R2_BUCKET, R2_PUBLIC_URL } = require('../lib/r2');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { isFileContentValid, extensionFor } = require('../lib/fileCheck');

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
  'application/pdf', // uniquement dans le dossier « documents » (vérifié dans la route)
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

// Nom de fichier sûr : base nettoyée (sans extension d'origine) + extension du type vérifié
function sanitizeName(name, mimetype) {
  const base = (name || 'file').replace(/\.[^.]*$/, '').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'file';
  return `${base}.${extensionFor(mimetype)}`;
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
      const isImage = !req.file.mimetype.startsWith('video/'); // images et PDF : 25 Mo
      const maxSize = isImage ? IMAGE_MAX_SIZE : VIDEO_MAX_SIZE;
      if (req.file.size > maxSize) {
        const maxLabel = isImage ? '25MB' : '100MB';
        return res.status(413).json({ error: 'FILE_TOO_LARGE', max: maxLabel });
      }

      // Validation du contenu réel (images ET vidéos) — anti-spoofing
      if (!isFileContentValid(req.file.buffer, req.file.mimetype)) {
        console.warn(`⚠️ Contenu invalide pour un fichier ${req.file.mimetype}`);
        return res.status(400).json({ error: 'FORMAT_NOT_ALLOWED' });
      }

      // Validation du dossier de destination (allowlist)
      const rawFolder = req.body.folder || 'media';
      const folder = ALLOWED_FOLDERS.has(rawFolder) ? rawFolder : 'media';
      if (req.file.mimetype === 'application/pdf' && folder !== 'documents') {
        return res.status(400).json({ error: 'FORMAT_NOT_ALLOWED' });
      }

      const key = `lsbookers/${folder}/${Date.now()}-${sanitizeName(req.file.originalname, req.file.mimetype)}`;

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

      return res.json({
        url,
        pathname: key,
        contentType: req.file.mimetype,
        size: req.file.size,
      });
    } catch (e) {
      console.error('❌ Upload route error:', e);
      return res.status(500).json({ error: 'SERVER_ERROR' });
    }
  });
});

module.exports = router;
