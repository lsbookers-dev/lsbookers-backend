// routes/upload.js — Vercel Blob (remplace Cloudinary)
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { put } = require('@vercel/blob');

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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 Mo
});

/* ----------------------------- Helpers ----------------------------------- */
function mapMulterError(err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return { status: 413, payload: { error: 'FILE_TOO_LARGE', max: '25MB' } };
    if (err.code === 'LIMIT_UNEXPECTED_FILE')
      return { status: 400, payload: { error: 'FORMAT_NOT_ALLOWED' } };
    return { status: 400, payload: { error: 'MULTER_ERROR', code: err.code } };
  }
  return { status: 500, payload: { error: 'UPLOAD_MIDDLEWARE_ERROR' } };
}

function sanitizeName(name) {
  return (name || 'file').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
}

/* ------------------------------ Route ------------------------------------ */
// POST /api/upload
// FormData attendu : file=<Blob>, folder?=avatars|banners|media|...
router.post('/', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const { status, payload } = mapMulterError(err);
      console.error('❌ Multer error:', err);
      return res.status(status).json(payload);
    }

    try {
      console.log('📨 Body reçu:', req.body);
      console.log('📂 Fichier reçu:', req.file ? {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
      } : null);

      if (!req.file) {
        return res.status(400).json({ error: 'NO_FILE' });
      }

      const { folder = 'media' } = req.body;
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
