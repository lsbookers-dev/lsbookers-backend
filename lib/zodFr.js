// lib/zodFr.js — Messages d'erreur de validation en français (zod 4 les écrit en anglais par défaut).
// Un champ manquant donne « Ce champ est obligatoire » plutôt qu'un message technique.
const { z } = require('zod')

z.config({
  ...z.locales.fr(),
  customError: (issue) => (issue.input === undefined ? 'Ce champ est obligatoire' : undefined),
})

module.exports = { z }
