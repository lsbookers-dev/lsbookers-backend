const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

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
const adminSettingsRoutes = require('./routes/adminSettings'); // paramètres du site
const eventRoutes = require('./routes/events');
const uploadRoutes = require('./routes/upload');
const publicationRoutes = require('./routes/publications');
const offersRoutes = require('./routes/offers'); // offres
const notificationsRoutes = require('./routes/notifications'); // notifications
const passwordRoutes = require('./routes/password'); // 🔐 forgot/reset password

const app = express();

// Necesaire pour que le rate limiting fonctionne derriere le proxy de Railway
app.set('trust proxy', 1);

/* ===================== Middlewares globaux ===================== */

// CORS — autorise uniquement lsbookers.com et localhost en développement
const allowedOrigins = [
  'https://www.lsbookers.com',
  'https://lsbookers.com',
  'http://localhost:3000',
  'http://localhost:3001',
];

const corsOptions = {
  origin: (origin, callback) => {
    // Autorise les requêtes sans origin (ex: Postman, Railway health checks)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origine non autorisée: ${origin}`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Cache-Control', 'Pragma', 'Expires'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Rate limiting — protection anti-brute-force
// Sur les routes sensibles (login, register, mot de passe)
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // fenetre de 5 minutes
  max: 10,                  // max 10 tentatives par IP sur cette fenetre
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, reessayez dans 5 minutes' },
});

// Sur l'ensemble de l'API — protection générale
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,            // max 200 requêtes par IP par minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, ralentissez ❌' },
});

app.use(globalLimiter);

// Parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logs (désactivés en production pour les performances)
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Static (uploads locaux — à migrer vers Bunny.net)
app.use('/uploads', express.static('uploads'));

/* ===================== Routes API ===================== */
// Rate limiting uniquement sur login et register (pas sur /me)
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/auth', passwordRoutes);

app.use('/api/profile', profileRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/follow', followRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/search', searchRoutes);
app.use('/api', usersRoutes);

// ⚠️ IMPORTANT : monter /api/admin/settings AVANT /api/admin
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api/events', eventRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/publications', publicationRoutes);
app.use('/api/offers', offersRoutes);
app.use('/api/notifications', notificationsRoutes);

/* ===================== Gestion d’erreurs ===================== */
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
});

/* ===================== Démarrage ===================== */
const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Serveur lancé sur http://0.0.0.0:${PORT}`);
});