// lib/r2.js — Client S3-compatible Cloudflare R2
// Variables d'environnement requises (Railway) :
//   R2_ACCOUNT_ID        — ex : abc123def456...
//   R2_ACCESS_KEY_ID     — clé API R2
//   R2_SECRET_ACCESS_KEY — secret API R2
//   R2_BUCKET_NAME       — nom du bucket, ex : lsbookers-media
//   R2_PUBLIC_URL        — URL publique du bucket, ex : https://media.lsbookers.com (ou https://pub-xxxx.r2.dev)
//   R2_LEGACY_PUBLIC_URLS — anciennes URL publiques encore présentes en base, séparées par des virgules
//                           (défaut : l'adresse r2.dev d'origine, gardée lisible après le passage à media.lsbookers.com, #324)

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')

// R2_ENDPOINT : uniquement pour les essais en local (faux stockage sur l'ordinateur)
const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: !!process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

// Client des adresses d'envoi signées (#275) : sans code de contrôle « crc32 » ajouté d'office,
// sinon il serait calculé sur un fichier vide et R2 refuserait le vrai fichier envoyé par le navigateur
const r2PresignClient = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: !!process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

const R2_BUCKET = process.env.R2_BUCKET_NAME
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
const R2_LEGACY_PUBLIC_URLS = (process.env.R2_LEGACY_PUBLIC_URLS ?? 'https://pub-28115fb1c7084199a44966ca2924104c.r2.dev')
  .split(',').map(u => u.trim().replace(/\/$/, '')).filter(Boolean)
// Toutes les adresses sous lesquelles nos fichiers ont pu être enregistrés (actuelle en premier)
const R2_ALL_PUBLIC_URLS = [...new Set([R2_PUBLIC_URL, ...R2_LEGACY_PUBLIC_URLS].filter(Boolean))]

/** Clé R2 d'une adresse publique à nous (actuelle ou ancienne), sinon null */
function keyFromPublicUrl(url) {
  if (typeof url !== 'string') return null
  // Le « / » final est obligatoire : https://pub-x.r2.dev.pirate.com ne doit pas passer
  const base = R2_ALL_PUBLIC_URLS.find(b => url.startsWith(`${b}/`))
  return base ? url.slice(base.length + 1) : null
}

/** Envoie un buffer sur R2 sous lsbookers/<key> et renvoie son URL publique */
async function uploadBufferToR2(buffer, key, contentType) {
  const fullKey = `lsbookers/${key}`
  await r2Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: fullKey,
    Body: buffer,
    ContentType: contentType,
    ContentLength: buffer.length,
  }))
  return `${R2_PUBLIC_URL}/${fullKey}`
}

/** Supprime un fichier R2 à partir de son URL publique (ignore les autres URLs, silencieux si erreur) */
async function deleteR2Object(url) {
  const key = keyFromPublicUrl(url)
  if (!key) return
  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }))
  } catch (e) {
    console.warn('⚠️ R2 delete failed for', url, e.message)
  }
}

module.exports = { r2Client, r2PresignClient, R2_BUCKET, R2_PUBLIC_URL, keyFromPublicUrl, uploadBufferToR2, deleteR2Object }
