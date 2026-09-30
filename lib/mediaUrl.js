// lib/mediaUrl.js — N'accepter que des adresses de médias hébergés chez nous
// (bucket Cloudflare R2, ou anciens fichiers Vercel Blob). Empêche d'afficher sur le
// site des images/liens pointant vers des serveurs tiers (pistage, contenu piégé).
const { R2_PUBLIC_URL } = require('./r2')

function isOwnMediaUrl(url) {
  if (typeof url !== 'string') return false
  const value = url.trim()
  if (!value) return false
  // Le « / » final est obligatoire : https://pub-x.r2.dev.pirate.com ne doit pas passer
  if (R2_PUBLIC_URL && value.startsWith(`${R2_PUBLIC_URL}/`)) return true
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.public.blob.vercel-storage.com')
  } catch {
    return false
  }
}

/** Vide / null (= suppression du média) ou adresse à nous */
function isEmptyOrOwnMediaUrl(url) {
  return url === undefined || url === null || (typeof url === 'string' && url.trim() === '') || isOwnMediaUrl(url)
}

module.exports = { isOwnMediaUrl, isEmptyOrOwnMediaUrl }
