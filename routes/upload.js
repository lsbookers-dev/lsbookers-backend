// routes/upload.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('../config/cloudinary');

/* ------------------------ Sécurité / Sanity check ------------------------ */
const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.warn('⚠️  Cloudinary env vars manquantes. Vérifie ton .env (CLOUDINARY_*)');
}

/* --------------------------- Multer configuration ------------------------ */
const storage = multer.memoryStorage(); // pas de fichiers sur disque

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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 Mo
});

/* ----------------------------- Helpers ----------------------------------- */
function mapMulterError(err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return { status: 413, payload: { error: 'FILE_TOO_LARGE', max: '25MB' } };
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return { status: 400, payload: { error: 'FORMAT_NOT_ALLOWED' } };
    }
    return { status: 400, payload: { error: 'MULTER_ERROR', code: err.code } };
  }
  return { status: 500, payload: { error: 'UPLOAD_MIDDLEWARE_ERROR' } };
}

/* ------------------------------ Route ------------------------------------ */
// POST /api/upload
// FormData attendu : file=<Blob>, folder?=avatars|banners|media|..., type?=image|video|auto
router.post('/', (req, res) => {
  // ⚠️ Important: on gère Multer ici pour capturer ses erreurs explicitement
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const { status, payload } = mapMulterError(err);
      console.error('❌ Multer error:', err);
      return res.status(status).json(payload);
    }

    try {
      // Logs utiles pour debug
      console.log('📨 Body reçu:', req.body);
      console.log('📂 Fichier reçu:', req.file ? {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
      } : null);

      if (!req.file) {
        return res.status(400).json({ error: 'NO_FILE' });
      }

      const { folder = 'media', type = 'auto' } = req.body;
      const resource_type =
        type === 'video' ? 'video' : type === 'image' ? 'image' : 'auto';

      const cloudFolder = `lsbookers/${folder}`;

      // Timeout de sécurité : si Cloudinary ne répond pas en 20s, on renvoie une erreur
      let responded = false;
      const cloudinaryTimeout = setTimeout(() => {
        if (!responded) {
          responded = true;
          console.error('❌ Cloudinary timeout (20s)');
          res.status(504).json({ error: 'CLOUDINARY_TIMEOUT' });
        }
      }, 20000);

      const stream = cloudinary.uploader.upload_stream(
        {
          folder: cloudFolder,
          resource_type,
          overwrite: true,
        },
        (cloudErr, result) => {
          clearTimeout(cloudinaryTimeout);
          if (responded) return; // timeout déjà déclenché
          responded = true;

          if (cloudErr) {
            console.error('❌ Cloudinary error:', cloudErr);
            return res.status(502).json({
              error: 'CLOUDINARY_UPLOAD_FAILED',
              details: cloudErr.message || String(cloudErr),
            });
          }

          return res.json({
            url: result.secure_url,
            public_id: result.public_id,
            resource_type: result.resource_type,
            width: result.width,
            height: result.height,
            bytes: result.bytes,
            format: result.format,
            folder: result.folder,
          });
        }
      );

      // Envoi du buffer vers Cloudinary
      stream.end(req.file.buffer);
    } catch (e) {
      console.error('❌ Upload route error:', e);
      return res.status(500).json({ error: 'SERVER_ERROR', details: e.message });
    }
  });
});

module.exports = router;