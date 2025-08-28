// server.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config(); // charge .env (Cloudinary, DB, etc.)

// ✅ Importation des routes
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const mediaRoutes = require('./routes/media');
const messageRoutes = require('./routes/message');   // <-- assure-toi que le fichier s'appelle bien message.js
const followRoutes = require('./routes/follow');
const feedRoutes = require('./routes/feed');
const searchRoutes = require('./routes/search');
const usersRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const adminSettingsRoutes = require('./routes/adminSettings');
const eventRoutes = require('./routes/events');
const uploadRoutes = require('./routes/upload');

const app = express();

/* ===================== Middlewares globaux ===================== */

// CORS — autorise credentials et origine dynamique (dev + prod)
const corsOptions = {
  origin: true,           // reflète l'origine de la requête
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Authorization','Content-Type'],
};
app.use(cors(corsOptions));
// Important pour le caching inter-Origine (CDN/proxies)
app.use((req, res, next) => { res.header('Vary', 'Origin'); next(); });
// Gérer explicitement les préflight
app.options('*', cors(corsOptions));

// JSON/body parsers avec limites plus larges pour les images encodées
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Logs
app.use(morgan('dev'));

// ✅ Exposition du dossier "uploads" (si utilisé)
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
app.use('/api/upload', uploadRoutes);

/* ===================== Gestion d’erreurs ===================== */
// Renvoie un JSON propre en cas de 500 (et loggue la stack)
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Erreur serveur',
  });
});

/* ===================== Démarrage ===================== */
const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Serveur lancé sur http://0.0.0.0:${PORT}`);
});