// instrument.js — Surveillance des erreurs (Sentry), chargé en tout premier par server.js.
// Inactif tant que SENTRY_DSN n'est pas renseigné (variable Railway).
require('dotenv').config();
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN && process.env.NODE_ENV !== 'test') {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
    tracesSampleRate: 0,      // pas de mesure de performance : uniquement les erreurs
    sendDefaultPii: false,    // jamais d'adresse IP, cookie ou en-tête d'authentification
    // Les routes attrapent leurs erreurs et les écrivent avec console.error : on les remonte aussi
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
    beforeSend(event) {
      // Le corps des requêtes peut contenir un mot de passe ou des données personnelles
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        if (event.request.url) event.request.url = event.request.url.split('?')[0];
        delete event.request.query_string;
      }
      return event;
    },
  });
}

module.exports = Sentry;
