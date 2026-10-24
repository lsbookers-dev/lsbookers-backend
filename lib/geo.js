// lib/geo.js — Distances entre deux points GPS.

const EARTH_RADIUS_KM = 6371

// Distance « à vol d'oiseau » (formule de Haversine), en km
function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = d => (d * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLon = rad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * Filtre Prisma « carré » autour d'un point : la base ne renvoie que les profils
 * situés dans ce carré (rapide grâce à l'index latitude/longitude), puis on garde
 * ceux qui sont vraiment dans le cercle avec haversineKm.
 */
function boundingBoxWhere(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32
  const cosLat = Math.cos((lat * Math.PI) / 180)
  // Près des pôles le carré couvre toutes les longitudes
  const dLon = cosLat > 0.01 ? radiusKm / (111.32 * cosLat) : 180
  return {
    latitude: { gte: lat - dLat, lte: lat + dLat },
    longitude: { gte: lon - dLon, lte: lon + dLon },
  }
}

module.exports = { haversineKm, boundingBoxWhere }
