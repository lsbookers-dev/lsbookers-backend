/**
 * schemas/index.js — Tous les schémas de validation Zod de l'API
 *
 * Chaque schéma correspond à un corps de requête (req.body).
 * Les champs marqués .optional() ne sont pas obligatoires.
 * .trim() sur les strings supprime les espaces en début/fin.
 * stripHtml() supprime les balises HTML des champs texte libres (anti-XSS stocké).
 */

const { z } = require('zod');

// Supprime les balises HTML d'une chaîne (ex: <script>, <b>, etc.)
// Appliqué sur tous les champs texte libres avant stockage en base.
const stripHtml = (s) => (typeof s === 'string' ? s.replace(/<[^>]*>/g, '') : s);

/* ─────────────────────────────────────────
   AUTH
───────────────────────────────────────── */

const registerSchema = z.object({
  email:    z.string().email('Adresse email invalide').toLowerCase().trim(),
  password: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères'),
  role:     z.enum(['ARTIST', 'ORGANIZER', 'PROVIDER'], { message: 'Rôle invalide' }),
});

const loginSchema = z.object({
  email:    z.string().email('Adresse email invalide').toLowerCase().trim(),
  password: z.string().min(1, 'Mot de passe requis'),
});

const step2Schema = z.object({
  pseudo:              z.string()
                        .min(3, 'Pseudo trop court (3 caractères minimum)')
                        .max(30, 'Pseudo trop long (30 caractères maximum)')
                        .regex(/^[a-zA-Z0-9_ .\-]+$/, 'Pseudo invalide : lettres, chiffres, espaces, tirets, underscores uniquement')
                        .trim(),
  firstName:           z.string().min(1, 'Prénom requis').max(50).trim().transform(stripHtml),
  lastName:            z.string().min(1, 'Nom requis').max(50).trim().transform(stripHtml),
  dateOfBirth:         z.string().optional(),
  phone:               z.string().max(20).trim().optional(),
  countryOfResidence:  z.string().max(100).trim().transform(stripHtml).optional(),
});

const step3Schema = z.object({
  bio:                z.string().max(600, 'Bio trop longue (600 caractères maximum)').trim().transform(stripHtml).optional(),
  profession:         z.string().max(100).trim().transform(stripHtml).optional(),
  location:           z.string().max(100).trim().transform(stripHtml).optional(),
  country:            z.string().max(100).trim().transform(stripHtml).optional(),
  legalStatus:        z.enum(['INDIVIDUAL', 'AUTO_ENTREPRENEUR', 'COMPANY']).optional(),
  organizerType:      z.enum(['INDIVIDUAL', 'PROFESSIONAL']).optional(),
  establishmentName:  z.string().max(200).trim().transform(stripHtml).optional(),
  typeEtablissement:  z.string().max(100).trim().transform(stripHtml).optional(),
  siret:              z.string().max(20).trim().optional(),
  address:            z.string().max(200).trim().transform(stripHtml).optional(),
  postalCode:         z.string().max(10).trim().optional(),
  city:               z.string().max(100).trim().transform(stripHtml).optional(),
});

const registerCompleteSchema = registerSchema.merge(step2Schema).merge(step3Schema);

const resendVerificationSchema = z.object({
  email: z.string().email('Adresse email invalide').toLowerCase().trim(),
});

/* ─────────────────────────────────────────
   PROFILE
───────────────────────────────────────── */

const profileUpdateSchema = z.object({
  bio:                     z.string().max(600, 'Bio trop longue').trim().transform(stripHtml).optional().nullable(),
  location:                z.string().max(100).trim().transform(stripHtml).optional().nullable(),
  country:                 z.string().max(100).trim().transform(stripHtml).optional().nullable(),
  profession:              z.string().max(100).trim().transform(stripHtml).optional().nullable(),
  typeEtablissement:       z.string().max(100).trim().transform(stripHtml).optional().nullable(),
  radiusKm:                z.number().int().min(0).max(5000).optional().nullable(),
  latitude:                z.number().min(-90).max(90).optional().nullable(),
  longitude:               z.number().min(-180).max(180).optional().nullable(),
  specialties:             z.array(z.string().max(100).transform(stripHtml)).max(20).optional(),
  styles:                  z.array(z.string().max(100).transform(stripHtml)).max(30).optional(),
  avatar:                  z.string().max(2000).optional().nullable(),
  banner:                  z.string().max(2000).optional().nullable(),
  avatarUrl:               z.string().max(2000).optional().nullable(),
  bannerUrl:               z.string().max(2000).optional().nullable(),
  soundcloudUrl:           z.string().url('URL SoundCloud invalide').optional().nullable().or(z.literal('')),
  youtubeUrl:              z.string().url('URL YouTube invalide').optional().nullable().or(z.literal('')),
  showSoundcloud:          z.boolean().optional(),
  availableForBooking:     z.boolean().optional(),
  showRealName:            z.boolean().optional(),
  notificationPreferences: z.record(z.string(), z.boolean()).optional(),
});

/* ─────────────────────────────────────────
   OFFERS
───────────────────────────────────────── */

const offerCreateSchema = z.object({
  title:       z.string().min(2, 'Titre trop court').max(150, 'Titre trop long').trim().transform(stripHtml),
  description: z.string().min(10, 'Description trop courte').max(2000, 'Description trop longue').trim().transform(stripHtml),
  type:        z.enum(['ARTIST', 'PROVIDER', 'ALL'], { message: 'Type invalide' }),
  specialty:   z.string().min(1, 'Spécialité requise').max(100).trim().transform(stripHtml),
  date:        z.string().min(1, 'Date requise'),
  location:    z.string().min(1, 'Ville requise').max(100).trim().transform(stripHtml),
  country:     z.string().min(1, 'Pays requis').max(100).trim().transform(stripHtml),
  radiusKm:    z.number().int().min(0).max(5000).optional().nullable(),
  fee:         z.number().min(0, 'Tarif invalide').optional().nullable(),
  eventId:     z.number().int().positive().optional().nullable(),
});

const offerUpdateSchema = offerCreateSchema.partial().extend({
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
});

/* ─────────────────────────────────────────
   EVENTS
───────────────────────────────────────── */

const eventCreateSchema = z.object({
  title:       z.string().min(1, 'Titre requis').max(200).trim().transform(stripHtml),
  start:       z.string().min(1, 'Date de début requise'),
  end:         z.string().optional().nullable(),
  allDay:      z.boolean().optional(),
  lieu:        z.string().max(200).trim().transform(stripHtml).optional().nullable(),
  category:    z.string().max(100).trim().transform(stripHtml).optional().nullable(),
  description: z.string().max(2000).trim().transform(stripHtml).optional().nullable(),
  notes:       z.string().max(2000).trim().transform(stripHtml).optional().nullable(),
  isPrivate:   z.boolean().optional(),
  budget:      z.number().min(0).optional().nullable(),
  maxCapacity: z.number().int().min(0).optional().nullable(),
  status:      z.enum(['DRAFT', 'PUBLISHED', 'CANCELLED']).optional(),
  coverImage:  z.string().url().optional().nullable(),
});

const eventUpdateSchema = eventCreateSchema.partial();

/* ─────────────────────────────────────────
   PUBLICATIONS
───────────────────────────────────────── */

const publicationCreateSchema = z.object({
  title:      z.string().min(1, 'Titre requis').max(200).trim().transform(stripHtml),
  media:      z.string().min(1, 'Média requis').max(2000).trim(),
  mediaType:  z.preprocess(v => typeof v === 'string' ? v.toLowerCase() : v, z.enum(['image', 'video', 'audio'])).optional(),
  caption:    z.string().max(2000).trim().transform(stripHtml).optional().nullable(),
  profileId:  z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  additionalMedia: z.array(z.object({
    url:       z.string().min(1).max(2000).trim(),
    mediaType: z.preprocess(v => typeof v === 'string' ? v.toLowerCase() : v, z.enum(['image', 'video', 'audio'])).optional(),
    order:     z.number().int().min(0).optional(),
  })).max(9).optional(),
});

const commentCreateSchema = z.object({
  content:  z.string().min(1, 'Commentaire requis').max(500, 'Commentaire trop long').trim().transform(stripHtml),
  parentId: z.number().int().positive().optional().nullable(),
});

/* ─────────────────────────────────────────
   MESSAGES
───────────────────────────────────────── */

const messageCreateSchema = z.object({
  conversationId: z.number().int().positive('ID conversation invalide'),
  content:        z.string().min(1, 'Message requis').max(5000, 'Message trop long').trim().transform(stripHtml),
});

const conversationCreateSchema = z.object({
  recipientId: z.number().int().positive('ID destinataire invalide'),
  content:     z.string().min(1, 'Message requis').max(5000, 'Message trop long').trim().transform(stripHtml),
});

/* ─────────────────────────────────────────
   REVIEWS
───────────────────────────────────────── */

const reviewCreateSchema = z.object({
  targetId: z.number().int().positive('ID profil invalide'),
  rating:   z.number().int().min(1, 'Note minimum 1').max(5, 'Note maximum 5'),
  comment:  z.string().max(1000, 'Commentaire trop long').trim().transform(stripHtml).optional(),
  eventId:  z.number().int().positive().optional().nullable(),
});

/* ─────────────────────────────────────────
   PASSWORD
───────────────────────────────────────── */

const forgotPasswordSchema = z.object({
  email: z.string().email('Adresse email invalide').toLowerCase().trim(),
});

const resetPasswordSchema = z.object({
  token:    z.string().min(1, 'Token requis'),
  password: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères'),
});

/* ─────────────────────────────────────────
   MEDIA
───────────────────────────────────────── */

const mediaCreateSchema = z.object({
  title:   z.string().min(1, 'Titre requis').max(200).trim().transform(stripHtml),
  url:     z.string().min(1, 'URL requise').max(2000).trim(),
  caption: z.string().max(500).trim().transform(stripHtml).optional().nullable(),
});

/* ─────────────────────────────────────────
   ADMIN
───────────────────────────────────────── */

const adminRoleUpdateSchema = z.object({
  role: z.enum(['ARTIST', 'ORGANIZER', 'PROVIDER'], { message: 'Rôle invalide. Valeurs acceptées : ARTIST, ORGANIZER, PROVIDER' }),
});

const adminSettingsUpdateSchema = z.object({
  welcomeText:     z.string().max(500).trim().transform(stripHtml).optional(),
  landingBgUrl:    z.string().max(2000).trim().optional(),
  loginBgUrl:      z.string().max(2000).trim().optional(),
  registerBgUrl:   z.string().max(2000).trim().optional(),
  headerLogoUrl:   z.string().max(2000).trim().optional(),
  mainColor:       z.string().max(20).trim().optional(),
  secondaryColor:  z.string().max(20).trim().optional(),
  bannerUrl:       z.string().max(2000).trim().optional(),
  logoUrl:         z.string().max(2000).trim().optional(),
});

/* ─────────────────────────────────────────
   CONTACT
───────────────────────────────────────── */

const contactCreateSchema = z.object({
  name:    z.string().min(1, 'Nom requis').max(100).trim().transform(stripHtml),
  email:   z.string().email('Email invalide').toLowerCase().trim(),
  subject: z.string().max(200).trim().transform(stripHtml).optional(),
  message: z.string().min(10, 'Message trop court').max(3000, 'Message trop long').trim().transform(stripHtml),
});

/* ─────────────────────────────────────────
   EXPORTS
───────────────────────────────────────── */

module.exports = {
  // Auth
  registerSchema,
  loginSchema,
  step2Schema,
  step3Schema,
  registerCompleteSchema,
  resendVerificationSchema,
  // Profile
  profileUpdateSchema,
  // Offers
  offerCreateSchema,
  offerUpdateSchema,
  // Events
  eventCreateSchema,
  eventUpdateSchema,
  // Publications
  publicationCreateSchema,
  commentCreateSchema,
  // Messages
  messageCreateSchema,
  conversationCreateSchema,
  // Reviews
  reviewCreateSchema,
  // Password
  forgotPasswordSchema,
  resetPasswordSchema,
  // Media
  mediaCreateSchema,
  // Admin
  adminRoleUpdateSchema,
  adminSettingsUpdateSchema,
  // Contact
  contactCreateSchema,
};
