const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
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
const adminSettingsRoutes = require('./routes/adminSettings'); // <-- paramètres du site
const eventRoutes = require('./routes/events');
const uploadRoutes = require('./routes/upload');
const publicationRoutes = require('./routes/publications'); // Nouvelle ligne pour publications
const offersRoutes = require('./routes/offers'); // ✅ Nouvelle ligne pour offres
const notificationsRoutes = require('./routes/notifications'); // ✅ Nouvelle ligne pour notifications
const app = express();
/* ===================== Middlewares globaux ===================== */
// CORS
const corsOptions = {
origin: true,
credentials: true,
methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
allowedHeaders: ['Authorization', 'Content-Type', 'Cache-Control', 'Pragma', 'Expires'],
};
app.use(cors(corsOptions));
app.use((req, res, next) => { res.header('Vary', 'Origin'); next(); });
app.options('*', cors(corsOptions));
// Parsers
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
// Logs
app.use(morgan('dev'));
// Static
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
// ⚠️ IMPORTANT : monter /api/admin/settings AVANT /api/admin
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/publications', publicationRoutes);
app.use('/api/offers', offersRoutes); // ✅ Activation de la route des offres
app.use('/api/notifications', notificationsRoutes); // ✅ Activation de la route des notifications
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