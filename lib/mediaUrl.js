// lib/mediaUrl.js — N'accepter que des adresses de médias hébergés chez nous
// (bucket Cloudflare R2). Les anciens fichiers Vercel Blob ont été déplacés le 31/10/2026. Empêche d'afficher sur le
// site des images/liens pointant vers des serveurs tiers (pistage, contenu piégé).
const { keyFromPublicUrl } = require('./r2')

function isOwnMediaUrl(url) {
  if (typeof url !== 'string') return false
  const value = url.trim()
  if (!value) return false
  // Adresse actuelle (media.lsbookers.com) ou ancienne (r2.dev) de notre stockage
  return !!keyFromPublicUrl(value)
}

/** Vide / null (= suppression du média) ou adresse à nous */
function isEmptyOrOwnMediaUrl(url) {
  return url === undefined || url === null || (typeof url === 'string' && url.trim() === '') || isOwnMediaUrl(url)
}

module.exports = { isOwnMediaUrl, isEmptyOrOwnMediaUrl }
