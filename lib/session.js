// lib/session.js — Cookie de session (jeton JWT) : réglages uniques
//
// SameSite=Lax (jamais None) : le navigateur n'envoie pas le cookie depuis un autre site,
// ce qui bloque le CSRF en plus de csrfGuard. Secure dès que la requête arrive en HTTPS.
// Le cookie n'est utilisable par le site que si l'API est sur le même site que la page
// (api.lsbookers.com pour lsbookers.com) : c'est le mode « cookie uniquement ».

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000

function cookieOptions(req) {
  return { httpOnly: true, secure: !!req.secure, sameSite: 'lax', path: '/' }
}

function setSessionCookie(req, res, token) {
  res.cookie('token', token, { ...cookieOptions(req), maxAge: SESSION_MAX_AGE })
}

function clearSessionCookie(req, res) {
  res.clearCookie('token', cookieOptions(req))
}

const registrableDomain = (hostname) =>
  hostname === 'localhost' || /^[\d.]+$/.test(hostname) ? hostname : hostname.split('.').slice(-2).join('.')

/** Vrai si la page qui appelle est sur le même site que l'API → le cookie suffit, pas besoin du jeton */
function isSameSiteRequest(req) {
  try {
    const origin = new URL(req.headers.origin)
    return registrableDomain(origin.hostname) === registrableDomain(req.hostname)
  } catch {
    return false
  }
}

/** Lit le cookie « token » dans un en-tête Cookie brut (poignée de main du socket) */
function tokenFromCookieHeader(header) {
  for (const part of String(header || '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === 'token') {
      try { return decodeURIComponent(rest.join('=')) } catch { return null }
    }
  }
  return null
}

module.exports = { setSessionCookie, clearSessionCookie, isSameSiteRequest, tokenFromCookieHeader }
