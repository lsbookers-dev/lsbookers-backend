// lib/r2.js — Client S3-compatible Cloudflare R2
// Variables d'environnement requises (Railway) :
//   R2_ACCOUNT_ID        — ex : abc123def456...
//   R2_ACCESS_KEY_ID     — clé API R2
//   R2_SECRET_ACCESS_KEY — secret API R2
//   R2_BUCKET_NAME       — nom du bucket, ex : lsbookers-media
//   R2_PUBLIC_URL        — URL publique du bucket, ex : https://pub-xxxx.r2.dev

const { S3Client } = require('@aws-sdk/client-s3')

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

const R2_BUCKET = process.env.R2_BUCKET_NAME
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

module.exports = { r2Client, R2_BUCKET, R2_PUBLIC_URL }
