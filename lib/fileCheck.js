// lib/fileCheck.js — Vérification du contenu réel des fichiers envoyés (anti-spoofing)
// Le type annoncé par le navigateur (mimetype) peut être falsifié : on vérifie les
// premiers octets du fichier (« magic bytes ») pour chaque format accepté.

const startsWith = (buf, bytes, offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b)
const ascii = (s) => [...s].map((c) => c.charCodeAt(0))

const isRiff = (buf, kind) => startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii(kind), 8)
// MP4 / MOV : boîte « ftyp » à l'octet 4 (MOV ancien : « moov », « wide », « mdat », « free »)
const isIsoMedia = (buf) =>
  ['ftyp', 'moov', 'wide', 'mdat', 'free', 'skip'].some((box) => startsWith(buf, ascii(box), 4))
const isEbml = (buf) => startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3]) // WebM / Matroska
const isOgg = (buf) => startsWith(buf, ascii('OggS'))
const isMp3 = (buf) => startsWith(buf, ascii('ID3')) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)

const CHECKS = {
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]),
  'image/gif': (b) => startsWith(b, ascii('GIF8')),
  'image/webp': (b) => isRiff(b, 'WEBP'),
  'video/mp4': isIsoMedia,
  'video/quicktime': isIsoMedia,
  'video/webm': isEbml,
  'video/ogg': isOgg,
  'application/pdf': (b) => startsWith(b, ascii('%PDF-')),
  'audio/mpeg': isMp3,
  'audio/wav': (b) => isRiff(b, 'WAVE'),
  'audio/ogg': isOgg,
}

const EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/ogg': 'ogv',
  'application/pdf': 'pdf', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
}

/** Vrai si le contenu du fichier correspond bien au type annoncé (et que ce type est connu). */
function isFileContentValid(buf, mimetype) {
  const check = CHECKS[mimetype]
  if (!check || !buf || buf.length < 12) return false
  return check(buf)
}

/** Extension sûre déduite du type vérifié (jamais du nom de fichier d'origine). */
function extensionFor(mimetype) {
  return EXTENSIONS[mimetype] || 'bin'
}

module.exports = { isFileContentValid, extensionFor }
