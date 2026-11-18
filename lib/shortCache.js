// lib/shortCache.js — Petite mémoire de courte durée (audit du 18/11/2026)
//
// Pour les calculs lourds demandés par beaucoup de membres en même temps (tendances du fil,
// recherches identiques) : le résultat est gardé quelques instants au lieu d'être recalculé
// à chaque visite. Les demandes simultanées attendent le même calcul (un seul appel à la base).
// Mémoire propre au serveur : suffisant tant que le site tourne sur un seul serveur.

function createShortCache({ ttlMs, max = 100 }) {
  const entries = new Map()

  function get(key, load) {
    const now = Date.now()
    const hit = entries.get(key)
    if (hit && now - hit.at < ttlMs) return hit.promise
    const promise = Promise.resolve().then(load)
    entries.delete(key)
    entries.set(key, { at: now, promise })
    if (entries.size > max) entries.delete(entries.keys().next().value) // la plus ancienne
    // Un calcul en échec n'est pas gardé : la demande suivante réessaie
    promise.catch(() => { if (entries.get(key)?.promise === promise) entries.delete(key) })
    return promise
  }

  return { get, clear: () => entries.clear(), size: () => entries.size }
}

module.exports = { createShortCache }
