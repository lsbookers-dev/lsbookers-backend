// lib/directUpload.js — Envoi direct des fichiers du navigateur vers Cloudflare R2 (#275)
//
// 1. Le site demande une autorisation (createUploadUrl) : le serveur vérifie type, taille et dossier,
//    puis signe une adresse d'envoi valable 5 min pour CE fichier (type et taille exacts).
// 2. Le navigateur envoie le fichier directement à R2 : le serveur ne le garde plus en mémoire.
// 3. Le site confirme (confirmUpload) : le serveur relit les premiers octets du fichier sur R2 pour
//    vérifier que c'est bien le format annoncé ; sinon le fichier est supprimé.
//
// receiveFile() accepte les deux façons de recevoir un fichier : à l'ancienne (multipart, req.file)
// ou déjà déposé par le navigateur (req.body.fileKey). L'ancienne sert de secours tant que la règle
// CORS du stockage R2 n'autorise pas l'envoi depuis le navigateur.
const crypto = require('crypto')
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const { r2Client, r2PresignClient, R2_BUCKET, R2_PUBLIC_URL, uploadBufferToR2 } = require('./r2')
const { isFileContentValid, extensionFor } = require('./fileCheck')

const MB = 1024 * 1024
const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const VIDEOS = ['video/mp4', 'video/quicktime', 'video/webm', 'video/ogg']
const CACHE_CONTROL = 'public, max-age=31536000, immutable'
const URL_TTL_SECONDS = 5 * 60

// Ce que chaque envoi accepte : dossiers, types et taille maximale (selon le type)
const PURPOSES = {
  // Envoi général : publications, albums, photo de profil, bannière, documents de l'agenda, admin
  general: {
    folders: ['avatars', 'banners', 'media', 'documents', 'logos'],
    types: [...IMAGES, ...VIDEOS, 'application/pdf'],
    // Un PDF ne va que dans « documents »
    allowed: (type, folder) => type !== 'application/pdf' || folder === 'documents',
    maxSize: type => (type.startsWith('video/') ? 100 * MB : 25 * MB),
  },
  message: {
    folders: ['messages'],
    types: [...IMAGES, 'video/mp4', 'video/quicktime', 'video/webm', 'application/pdf', 'audio/mpeg', 'audio/wav', 'audio/ogg'],
    maxSize: () => 25 * MB,
  },
  'booking-logistics': {
    folders: ['logistics'],
    types: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    maxSize: () => 50 * MB,
  },
  'booking-media': {
    folders: ['booking-media'],
    types: [...IMAGES, 'video/mp4', 'video/quicktime', 'video/webm'],
    maxSize: () => 50 * MB,
  },
  'booking-contract': {
    folders: ['contracts'],
    types: ['application/pdf'],
    maxSize: () => 50 * MB,
  },
}

class UploadError extends Error {
  constructor(status, code, extra = {}) {
    super(code)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

const sizeLabel = bytes => `${Math.round(bytes / MB)}MB`

// Nom de fichier sûr : base nettoyée (sans extension d'origine) + extension du type vérifié
function safeFileName(name, type) {
  const base = String(name || 'file').replace(/\.[^.]*$/, '').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'file'
  return `${base}.${extensionFor(type)}`
}

/** Vérifie la demande et renvoie { purpose, folder } ou lève une UploadError */
function checkRequest({ purpose, folder, contentType, size }) {
  const rules = PURPOSES[purpose]
  if (!rules) throw new UploadError(400, 'UPLOAD_PURPOSE_INVALID')
  const target = rules.folders.includes(folder) ? folder : rules.folders[0]
  if (!rules.types.includes(contentType)) throw new UploadError(400, 'FORMAT_NOT_ALLOWED')
  if (rules.allowed && !rules.allowed(contentType, target)) throw new UploadError(400, 'FORMAT_NOT_ALLOWED')
  const n = Number(size)
  if (!Number.isInteger(n) || n <= 0) throw new UploadError(400, 'FILE_SIZE_INVALID')
  const max = rules.maxSize(contentType)
  if (n > max) throw new UploadError(413, 'FILE_TOO_LARGE', { max: sizeLabel(max) })
  return { rules, folder: target, size: n }
}

/**
 * Autorisation d'envoi direct. Renvoie l'adresse signée, la clé du futur fichier
 * et les en-têtes que le navigateur doit envoyer tels quels.
 */
async function createUploadUrl({ userId, purpose, folder, contentType, size, name }) {
  const checked = checkRequest({ purpose, folder, contentType, size })
  // Le numéro du membre est dans la clé : personne ne peut confirmer le fichier d'un autre
  const key = `lsbookers/${checked.folder}/u${Number(userId)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeFileName(name, contentType)}`
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: checked.size,
    CacheControl: CACHE_CONTROL,
  })
  // Type et taille font partie de la signature : R2 refuse tout autre fichier
  const uploadUrl = await getSignedUrl(r2PresignClient, command, {
    expiresIn: URL_TTL_SECONDS,
    signableHeaders: new Set(['content-type', 'content-length', 'cache-control']),
  })
  return {
    uploadUrl,
    key,
    headers: { 'Content-Type': contentType, 'Cache-Control': CACHE_CONTROL },
    expiresIn: URL_TTL_SECONDS,
  }
}

function keyOwnedBy(key, userId, rules) {
  const m = /^lsbookers\/([a-z-]+)\/u(\d+)-\d+-[0-9a-f]{8}-[A-Za-z0-9_-]+\.[a-z0-9]+$/.exec(String(key || ''))
  return !!m && rules.folders.includes(m[1]) && Number(m[2]) === Number(userId)
}

async function deleteQuietly(key) {
  await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })).catch(() => {})
}

/**
 * Confirmation après l'envoi direct : le fichier existe, appartient au membre, respecte
 * la taille et commence bien par les octets du format annoncé. Sinon il est supprimé.
 */
async function confirmUpload({ userId, purpose, key }) {
  const rules = PURPOSES[purpose]
  if (!rules) throw new UploadError(400, 'UPLOAD_PURPOSE_INVALID')
  if (!keyOwnedBy(key, userId, rules)) throw new UploadError(403, 'UPLOAD_KEY_INVALID')

  let head
  try {
    head = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key, Range: 'bytes=0-63' }))
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) throw new UploadError(404, 'UPLOAD_NOT_FOUND')
    throw err
  }
  const firstBytes = Buffer.from(await head.Body.transformToByteArray())
  const total = Number(/\/(\d+)$/.exec(head.ContentRange || '')?.[1] ?? head.ContentLength ?? 0)
  const contentType = head.ContentType

  const valid = rules.types.includes(contentType)
    && (!rules.allowed || rules.allowed(contentType, key.split('/')[1]))
    && total > 0 && total <= rules.maxSize(contentType)
    && isFileContentValid(firstBytes, contentType)
  if (!valid) {
    await deleteQuietly(key)
    throw new UploadError(400, 'FORMAT_NOT_ALLOWED')
  }
  return { url: `${R2_PUBLIC_URL}/${key}`, key, contentType, size: total }
}

/**
 * Fichier joint à une requête : déjà déposé sur R2 (req.body.fileKey) ou envoyé à l'ancienne (req.file).
 * legacyKey(mimetype) donne l'emplacement R2 d'un fichier reçu à l'ancienne (sans « lsbookers/ »).
 * Renvoie { url, mimetype, name, size } ou null s'il n'y a pas de fichier.
 */
async function receiveFile(req, { purpose, legacyKey }) {
  const fileKey = req.body?.fileKey
  if (fileKey) {
    const confirmed = await confirmUpload({ userId: req.user.id, purpose, key: fileKey })
    const name = String(req.body.fileName || fileKey.split('/').pop()).slice(0, 200)
    return { url: confirmed.url, mimetype: confirmed.contentType, name, size: confirmed.size }
  }
  if (!req.file) return null
  if (!isFileContentValid(req.file.buffer, req.file.mimetype)) throw new UploadError(400, 'FORMAT_NOT_ALLOWED')
  const url = await uploadBufferToR2(req.file.buffer, legacyKey(req.file.mimetype), req.file.mimetype)
  return { url, mimetype: req.file.mimetype, name: req.file.originalname || null, size: req.file.size }
}

/** Réponse JSON d'une UploadError (autre erreur : relancée) */
function sendUploadError(res, err) {
  if (!(err instanceof UploadError)) throw err
  return res.status(err.status).json({ error: err.code, ...err.extra })
}

module.exports = { PURPOSES, UploadError, createUploadUrl, confirmUpload, receiveFile, sendUploadError, checkRequest }
