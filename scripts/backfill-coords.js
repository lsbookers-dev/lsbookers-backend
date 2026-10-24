// scripts/backfill-coords.js — Retrouve les coordonnées GPS des profils qui ont une ville
// mais pas de latitude/longitude (géocodage raté à l'enregistrement du profil).
// Sans coordonnées, un profil n'apparaît pas dans la recherche « ville + rayon ».
//
//   node scripts/backfill-coords.js           → affiche ce qui serait corrigé, sans rien écrire
//   node scripts/backfill-coords.js --write   → enregistre les coordonnées trouvées
//
// OpenStreetMap (Nominatim) n'accepte qu'une demande par seconde : le script attend entre deux.
require('dotenv').config()
const prisma = require('../prisma/client')

const WRITE = process.argv.includes('--write')
const HEADERS = { 'User-Agent': 'LSBookers/1.0 (contact@lsbookers.com)', 'Accept-Language': 'fr,en' }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function geocode(query) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`,
    { headers: HEADERS, signal: AbortSignal.timeout(10000) }
  )
  if (!res.ok) throw new Error(`Nominatim ${res.status}`)
  const data = await res.json()
  return Array.isArray(data) && data[0] ? { latitude: parseFloat(data[0].lat), longitude: parseFloat(data[0].lon) } : null
}

async function main() {
  const profiles = await prisma.profile.findMany({
    where: { OR: [{ latitude: null }, { longitude: null }], location: { not: null }, NOT: { location: '' } },
    select: { id: true, location: true, country: true },
  })
  console.log(`${profiles.length} profil(s) avec une ville mais sans coordonnées${WRITE ? '' : ' (aperçu, rien n\'est écrit)'}`)

  let fixed = 0
  for (const p of profiles) {
    const query = p.country ? `${p.location}, ${p.country}` : p.location
    try {
      const coords = await geocode(query)
      if (!coords) {
        console.log(`  #${p.id} « ${query} » : introuvable`)
      } else {
        console.log(`  #${p.id} « ${query} » → ${coords.latitude}, ${coords.longitude}`)
        if (WRITE) await prisma.profile.update({ where: { id: p.id }, data: coords })
        fixed++
      }
    } catch (err) {
      console.log(`  #${p.id} « ${query} » : erreur (${err.message})`)
    }
    await sleep(1100)
  }
  console.log(`${fixed} profil(s) ${WRITE ? 'corrigé(s)' : 'à corriger'}`)
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
