/**
 * validate.js — Middleware de validation Zod
 *
 * Usage dans une route :
 *   const { validate } = require('../middleware/validate');
 *   const { loginSchema } = require('../schemas');
 *   router.post('/login', validate(loginSchema), async (req, res) => { ... });
 *
 * Si la validation échoue → 400 avec les erreurs en JSON.
 * Si elle réussit → req.body est nettoyé et typé par Zod (strip des champs inconnus).
 */

const { ZodError } = require('zod');

/**
 * @param {import('zod').ZodSchema} schema
 */
function validate(schema) {
  return (req, res, next) => {
    try {
      // parse() lève une ZodError si invalide
      // stripUnknown : retire automatiquement les champs non définis dans le schéma
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const errors = err.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        // Message lisible pour le premier champ en erreur, aussi dans « error » :
        // beaucoup d'écrans du site affichent directement ce champ
        const message = errors[0]?.message || 'Données invalides';
        return res.status(400).json({
          error: message,
          code: 'VALIDATION_ERROR',
          details: errors,
          message,
        });
      }
      next(err);
    }
  };
}

module.exports = { validate };
