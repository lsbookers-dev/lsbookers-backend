const Sentry = require('./instrument'); // surveillance des erreurs, à charger en premier
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { memberOrIp, ipAndEmail } = require('./lib/rateLimitKeys');
const { init: initSocket } = require('./socket');
const { startScheduledJobs } = require('./services/scheduledJobs');
require('dotenv').config();

// ✅ Importation des routes
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const mediaRoutes = require('./routes/media');
const messageRoutes = require('./routes/message');
const followRoutes = require('./routes/follow');
const blockRoutes  = require('./routes/block');
const searchRoutes = require('./routes/search');
const adminRoutes = require('./routes/admin');
const adminSettingsRoutes = require('./routes/adminSettings'); // paramètres du site
const adminPostsRoutes = require('./routes/adminPosts'); // publications LSBookers
const accountRoutes = require('./routes/account'); // Réglages du compte
const adminFeaturedRoutes = require('./routes/adminFeatured'); // carrousel de l'accueil
const eventRoutes         = require('./routes/events');
const eventBookingRoutes  = require('./routes/event-bookings');
const eventStaffRoutes    = require('./routes/event-staff');
const eventDocumentRoutes = require('./routes/event-documents');
const uploadRoutes = require('./routes/upload');
const publicationRoutes = require('./routes/publications');
const albumsRoutes      = require('./routes/albums'); // albums
const offersRoutes = require('./routes/offers'); // offres
const notificationsRoutes = require('./routes/notifications'); // notifications
const bookingDetailRoutes = require('./routes/bookingDetail'); // détail booking (logistique, médias, notes)
const passwordRoutes = require('./routes/password'); // 🔐 forgot/reset password
const reviewsRoutes = require('./routes/reviews'); // avis
const homeRoutes = require('./routes/home'); // page d'accueil
const contactRoutes = require('./routes/contact'); // messages de contact
const spaceRoutes = require('./routes/space'); // Mon espace : tableau de bord, finances
const checklistRoutes = require('./routes/checklists'); // checklists d'événement
const invoiceRoutes = require('./routes/invoices'); // devis et factures
const billingRoutes = require('./routes/billing'); // Offres et abonnements (Pro, codes, formules)
const adminBillingRoutes = require('./routes/adminBilling'); // admin : réglages, codes, commandes, annulations
const payoutRoutes = require('./routes/payouts'); // Réglages › Paiements (compte Stripe Connect)
const bookingPaymentRoutes = require('./routes/bookingPayments'); // paiement d'un booking (direct ou en ligne)
const managersRoutes = require('./routes/managers'); // profils gérés (agent, plusieurs salles)
const stripeWebhookRoutes = require('./routes/stripeWebhook'); // messages de Stripe

const app = express();

// Necesaire pour que le rate limiting fonctionne derriere le proxy de Railway
app.set('trust proxy', 1);

/* ===================== Middlewares globaux ===================== */

// Helmet — sécurité des headers HTTP (XSS, clickjacking, MIME sniffing, etc.)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // réponses de l'API lisibles depuis lsbookers.com
}));

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
    // Origine inconnue : pas d'en-têtes CORS (le navigateur bloque la lecture) ;
    // les modifications sont en plus refusées par csrfGuard ci-dessous.
    callback(null, !origin || allowedOrigins.includes(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Device-Token', 'X-Act-As-Profile', 'Cache-Control', 'Pragma', 'Expires'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Rate limiting — par membre quand il est connecté, par adresse IP sinon (#278) :
// sur un wifi partagé (festival, salle), les membres ne se bloquent plus entre eux.

// Connexion, inscription, mot de passe : 10 essais / 5 min par adresse IP ET par e-mail visé…
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  keyGenerator: ipAndEmail,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, reessayez dans 5 minutes' },
});
// … et 100 essais / 5 min par adresse IP tous e-mails confondus (anti-robot)
const authIpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, reessayez dans 5 minutes' },
});

// Sur l'ensemble de l'API — protection générale
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,            // 300 requêtes par minute et par membre (ou par IP hors connexion)
  keyGenerator: memberOrIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, ralentissez' },
});

// Rate limit dédié messagerie — plus permissif (la messagerie est intensive)
const messagingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600, // 10 req/s pour la messagerie (conversations, messages, mark-seen)
  keyGenerator: memberOrIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes messagerie' },
});

// Point 5 — Appliquer le globalLimiter uniquement sur les routes hors messagerie.
// La messagerie a son propre limiter (600 req/min) monté directement sur /api/messages.
// Si globalLimiter (300) était appliqué en premier, messagingLimiter (600) n'aurait aucun effet.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/messages')) return next()
  globalLimiter(req, res, next)
});

// Parsers (pas de express.urlencoded : le site n'envoie que du JSON ou des fichiers,
// et les formulaires HTML classiques sont le vecteur typique des attaques CSRF)
app.use(cookieParser());

// Protection CSRF : toute requête qui modifie des données doit venir de lsbookers.com.
// Sans en-tête Origin (outil, serveur), le cookie de session n'est pas accepté.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    if (allowedOrigins.includes(origin)) return next();
    return res.status(403).json({ error: 'Origine non autorisée' });
  }
  if (req.cookies?.token) return res.status(403).json({ error: 'Origine manquante' });
  next();
}
app.use(csrfGuard);

// Messages de Stripe : corps brut obligatoire pour vérifier la signature (avant express.json)
app.use('/api/stripe/webhook', stripeWebhookRoutes);

app.use(express.json({ limit: '10mb' }));

// Logs (désactivés en production pour les performances)
// Journal des requêtes SANS la partie « ?… » de l'URL (peut contenir jetons, emails, recherches)
morgan.token('path-only', (req) => (req.originalUrl || req.url || '').split('?')[0]);
app.use(morgan(':method :path-only :status :response-time ms'));

/* ===================== Signalements CSP ===================== */
// Le navigateur signale ici les ressources bloquées par la politique de sécurité du site
// (permet de repérer un élément légitime oublié). Journal minimal : directive + domaine bloqué.
const cspReportLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.post('/api/csp-report', cspReportLimiter,
  express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '20kb' }),
  (req, res) => {
    const r = req.body?.['csp-report'] || req.body?.[0]?.body || {};
    let blocked = String(r['blocked-uri'] || r.blockedURL || '');
    try { blocked = new URL(blocked).origin; } catch {}
    let page = String(r['document-uri'] || r.documentURL || '');
    try { page = new URL(page).pathname; } catch {}
    console.warn('CSP bloqué:', r['violated-directive'] || r.effectiveDirective || '?', blocked.slice(0, 120), 'sur', page.slice(0, 80));
    res.status(204).end();
  });

/* ===================== Surveillance (UptimeRobot) ===================== */
// GET /api/health : « ok » si le serveur et la base de données répondent, 503 sinon
const prismaHealth = require('./prisma/client');
app.get('/api/health', async (_req, res) => {
  try {
    await prismaHealth.$queryRaw`SELECT 1`;
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'database_unavailable' });
  }
});

/* ===================== Routes API ===================== */
// Rate limiting uniquement sur login et register (pas sur /me)
for (const path of ['login', 'register', 'register-complete', 'resend-verification', 'forgot-password', 'reset-password']) {
  app.use(`/api/auth/${path}`, authIpLimiter, authLimiter);
}
app.use('/api/auth', authRoutes);
app.use('/api/auth', passwordRoutes);

app.use('/api/profile', profileRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/messages', messagingLimiter, messageRoutes);
app.use('/api/follow', followRoutes);
app.use('/api/block',  blockRoutes);
app.use('/api/search', searchRoutes);

// ⚠️ IMPORTANT : monter /api/admin/settings, /posts et /featured AVANT /api/admin
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin/posts', adminPostsRoutes);
app.use('/api/admin/featured', adminFeaturedRoutes);
app.use('/api/admin/billing', adminBillingRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api/events', eventRoutes);
app.use('/api/events', eventBookingRoutes);
app.use('/api/events', eventStaffRoutes);
app.use('/api/events', eventDocumentRoutes);
app.use('/api/events', checklistRoutes);
app.use('/api/bookings', bookingDetailRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/publications', publicationRoutes);
app.use('/api/albums', albumsRoutes);
app.use('/api/offers', offersRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/space', spaceRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/booking-payments', bookingPaymentRoutes);
app.use('/api/managers', managersRoutes);

/* ===================== Gestion d’erreurs ===================== */
// Envoie les erreurs serveur à Sentry (si SENTRY_DSN est renseigné) avant la réponse générique
Sentry.setupExpressErrorHandler(app);

// Route API inconnue → 404 JSON (et non la page HTML par défaut d'Express)
app.use((req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

// Erreurs non gérées : détail dans les logs, message générique pour le client
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status < 500) {
    // Erreur « client » : on ne journalise jamais l'objet complet (il peut contenir le corps
    // de la requête, donc un mot de passe ou des données personnelles)
    console.warn('Client error:', req.method, req.path, status, err.type || err.code || 'unknown');
  } else {
    console.error('Unhandled error:', req.method, req.path, err);
  }
  // Erreurs « client » connues (JSON invalide, corps trop gros) : message simple, sans détail interne
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requête invalide' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse' });
  res.status(status >= 400 && status < 500 ? status : 500).json({ error: status < 500 ? 'Requête refusée' : 'Erreur serveur' });
});

/* ===================== Démarrage ===================== */
const PORT = process.env.PORT || 5001;
const httpServer = http.createServer(app);

// Initialiser Socket.io sur le même serveur HTTP
initSocket(httpServer);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Serveur lancé sur http://0.0.0.0:${PORT} (WebSocket activé)`);
  if (process.env.NODE_ENV !== 'test') startScheduledJobs();
});

// Arrêt propre (mise à jour Railway, redémarrage) : on finit les requêtes en cours, puis on rend
// les connexions à la base au lieu de les laisser ouvertes jusqu'à ce que la base les coupe.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`⏹️  ${signal} reçu : arrêt propre du serveur`);
  const prisma = require('./prisma/client');
  const exit = () => prisma.$disconnect().catch(() => {}).finally(() => process.exit(0));
  httpServer.once('close', exit);
  // Ferme le temps réel (les sites ouverts se reconnectent tout seuls au nouveau serveur) et le serveur HTTP
  try { require('./socket').getIO().close(); } catch { httpServer.close(); }
  // Connexions qui traînent (temps réel, requêtes longues) : on n'attend pas plus de 10 s
  setTimeout(exit, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
