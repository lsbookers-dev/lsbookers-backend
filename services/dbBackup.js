// services/dbBackup.js — Sauvegarde quotidienne de la base de données (choix d'Antho, 24/10/2026)
// Railway Hobby ne sauvegarde pas : chaque nuit, pg_dump fait une copie complète de la base,
// rangée dans un espace Cloudflare R2 PRIVÉ (bucket lsbookers-backups, jamais public).
// On garde 30 jours de copies. Restauration pas à pas : scripts/RESTAURER.md
const { spawn } = require('child_process')
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3')

const BUCKET = process.env.BACKUP_BUCKET_NAME || 'lsbookers-backups'
const PREFIX = 'db/'
const KEEP_DAYS = 30
const DAY = 24 * 60 * 60 * 1000

const client = () => new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
})

// Date du jour à Paris, au format AAAA-MM-JJ
const parisDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)
const parisHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(d))

function pgDump() {
  return new Promise((resolve, reject) => {
    // Format « custom » : compressé, restaurable table par table avec pg_restore
    const p = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-acl', process.env.DATABASE_URL])
    const chunks = []
    let err = ''
    p.stdout.on('data', c => chunks.push(c))
    p.stderr.on('data', c => { err += c })
    p.on('error', reject) // pg_dump absent
    p.on('close', code => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`pg_dump a échoué (${code}) : ${err.slice(0, 300)}`))))
  })
}

async function listBackups(s3 = client()) {
  const out = []
  let token
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }))
    out.push(...(r.Contents || []))
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)
  return out.sort((a, b) => b.LastModified - a.LastModified)
}

/** Fait une sauvegarde maintenant, puis supprime les copies de plus de 30 jours */
async function runBackup() {
  const s3 = client()
  const started = Date.now()
  const dump = await pgDump()
  if (dump.length < 1024) throw new Error(`Sauvegarde anormalement petite (${dump.length} octets)`)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const key = `${PREFIX}lsbookers-${parisDay()}_${stamp}.dump`
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: dump, ContentType: 'application/octet-stream' }))

  // Rotation : on supprime au-delà de 30 jours, en gardant toujours au moins 7 copies
  const all = await listBackups(s3)
  const old = all.slice(7).filter(o => Date.now() - new Date(o.LastModified).getTime() > KEEP_DAYS * DAY)
  if (old.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: old.map(o => ({ Key: o.Key })) } }))

  console.log(`💾 Sauvegarde de la base : ${key} (${Math.round(dump.length / 1024)} Ko, ${Date.now() - started} ms, ${old.length} ancienne(s) supprimée(s))`)
  return { key, sizeBytes: dump.length, removed: old.length }
}

/** Tâche planifiée (vérifiée toutes les heures) : une sauvegarde par jour, à partir de 3 h du matin */
async function dailyBackupIfDue() {
  if (!process.env.R2_ACCOUNT_ID || !process.env.DATABASE_URL) return
  if (parisHour() < 3) return
  const today = parisDay()
  let existing
  try {
    existing = await listBackups()
  } catch (err) {
    // Espace privé pas encore créé ou pas encore autorisé : simple avertissement (pas d'alerte Sentry)
    console.warn(`Sauvegardes : espace ${BUCKET} inaccessible (${err.name})`)
    return
  }
  if (existing.some(o => o.Key.startsWith(`${PREFIX}lsbookers-${today}`))) return
  try {
    await runBackup()
  } catch (err) {
    console.error('❌ Sauvegarde de la base impossible :', err.message) // remonte dans Sentry
    try {
      const { notifyAdmins } = require('./adminAlerts')
      await notifyAdmins({ type: 'ADMIN_BACKUP_FAILED', content: `La sauvegarde automatique de la base a échoué cette nuit : ${err.message.slice(0, 120)}` })
    } catch { /* silencieux */ }
  }
}

module.exports = { runBackup, dailyBackupIfDue, listBackups, BUCKET }
