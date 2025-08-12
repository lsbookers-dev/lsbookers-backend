// server.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config(); // charge .env (Cloudinary, DB, etc.)

// ✅ Importation des routes
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const mediaRoutes = require('./routes/media');
const messageRoutes = require('./routes/message');
const followRoutes = require('./routes/follow');
const feedRoutes = require('./routes/feed');
const searchRoutes = require('./routes/search');
const usersRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const adminSettingsRoutes = require('./routes/adminSettings');
const eventRoutes = require('./routes/events');      // ✅
const uploadRoutes = require('./routes/upload');     // ✅ nouvelle route (Cloudinary)

const app = express();

/* ===================== Middlewares globaux ===================== */

// CORS — autorise credentials et origine dynamique (Vercel/localhost)
app.use(
  cors({
    origin: true,            // reflète l'origine de la requête (dev + prod)
    credentials: true,
  })
);

// JSON/body parsers avec limites plus larges pour les images encodées
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Logs dev
app.use(morgan('dev'));

// ✅ Exposition du dossier "uploads" (si tu en as encore besoin pour du local)
app.use('/uploads', express.static('uploads'));

/* ===================== Routes API ===================== */
app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/follow', followRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/search', searchRoutes);
app.use('/api', usersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/upload', uploadRoutes); // ⬅️ endpoints: POST /api/upload, /api/upload/avatar, /api/upload/banner, /api/upload/media

/* ===================== Démarrage ===================== */
const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Serveur lancé sur http://0.0.0.0:${PORT}`);
});