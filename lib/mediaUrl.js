// lib/mediaUrl.js — N'accepter que des adresses de médias hébergés chez nous
// (bucket Cloudflare R2, ou anciens fichiers Vercel Blob). Empêche d'afficher sur le
// site des images/liens pointant vers des serveurs tiers (pistage, contenu piégé).
const { keyFromPublicUrl } = require('./r2')

function isOwnMediaUrl(url) {
  if (typeof url !== 'string') return false
  const value = url.trim()
  if (!value) return false
  // Adresse actuelle (media.lsbookers.com) ou ancienne (r2.dev) de notre stockage
  if (keyFromPublicUrl(value)) return true
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
