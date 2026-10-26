// Jamais d'appel réel à R2 ni d'e-mail : tout est simulé
process.env.LSB_DISABLE_EMAILS = '1'

const test = require('node:test')
const assert = require('node:assert/strict')

const { r2Client } = require('../lib/r2')
const { checkRequest, confirmUpload, UploadError } = require('../lib/directUpload')

const MB = 1024 * 1024
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1]

test('autorisation : types, tailles et dossiers vérifiés avant de signer', () => {
  assert.equal(checkRequest({ purpose: 'general', folder: 'avatars', contentType: 'image/png', size: 1000 }).folder, 'avatars')
  // Dossier inconnu → dossier par défaut de l'envoi
  assert.equal(checkRequest({ purpose: 'general', folder: '../secret', contentType: 'image/png', size: 1000 }).folder, 'avatars')
  assert.equal(checkRequest({ purpose: 'message', contentType: 'application/pdf', size: 1000 }).folder, 'messages')

  const fails = (args, code) => assert.throws(() => checkRequest(args), e => e instanceof UploadError && e.code === code)
  fails({ purpose: 'general', folder: 'media', contentType: 'text/html', size: 10 }, 'FORMAT_NOT_ALLOWED')
  fails({ purpose: 'general', folder: 'media', contentType: 'application/pdf', size: 10 }, 'FORMAT_NOT_ALLOWED') // PDF hors « documents »
  fails({ purpose: 'general', folder: 'media', contentType: 'image/jpeg', size: 26 * MB }, 'FILE_TOO_LARGE')
  assert.doesNotThrow(() => checkRequest({ purpose: 'general', folder: 'media', contentType: 'video/mp4', size: 99 * MB }))
  fails({ purpose: 'general', folder: 'media', contentType: 'video/mp4', size: 101 * MB }, 'FILE_TOO_LARGE')
  fails({ purpose: 'message', contentType: 'video/mp4', size: 26 * MB }, 'FILE_TOO_LARGE')
  fails({ purpose: 'general', folder: 'media', contentType: 'image/png', size: 0 }, 'FILE_SIZE_INVALID')
  fails({ purpose: 'pirate', contentType: 'image/png', size: 10 }, 'UPLOAD_PURPOSE_INVALID')
})

async function withR2(handler, fn) {
  const original = r2Client.send
  const sent = []
  r2Client.send = async cmd => { sent.push(cmd); return handler(cmd) }
  try { return await fn(sent) } finally { r2Client.send = original }
}

const objectResponse = (bytes, total, type) => ({
  Body: { transformToByteArray: async () => Uint8Array.from(bytes) },
  ContentRange: `bytes 0-${bytes.length - 1}/${total}`,
  ContentType: type,
})

const KEY = 'lsbookers/avatars/u7-1761400000000-a1b2c3d4-photo.jpg'

test('confirmation : vrai fichier du membre → adresse publique', async () => {
  await withR2(() => objectResponse(JPEG, 2 * MB, 'image/jpeg'), async (sent) => {
    const file = await confirmUpload({ userId: 7, purpose: 'general', key: KEY })
    assert.ok(file.url.endsWith(`/${KEY}`))
    assert.equal(file.size, 2 * MB)
    assert.equal(sent[0].input.Range, 'bytes=0-63') // seuls les premiers octets sont lus
  })
})

test('confirmation : fichier d\'un autre membre refusé sans lire R2', async () => {
  await withR2(() => { throw new Error('ne doit pas être appelé') }, async (sent) => {
    await assert.rejects(confirmUpload({ userId: 8, purpose: 'general', key: KEY }), e => e.code === 'UPLOAD_KEY_INVALID')
    await assert.rejects(confirmUpload({ userId: 7, purpose: 'message', key: KEY }), e => e.code === 'UPLOAD_KEY_INVALID')
    await assert.rejects(confirmUpload({ userId: 7, purpose: 'general', key: 'lsbookers/avatars/../../x' }), e => e.code === 'UPLOAD_KEY_INVALID')
    assert.equal(sent.length, 0)
  })
})

test('confirmation : faux contenu ou trop gros → fichier supprimé', async () => {
  const html = [...Buffer.from('<html><script>alert(1)</script>')]
  await withR2(cmd => (cmd.constructor.name === 'GetObjectCommand' ? objectResponse(html, 500, 'image/jpeg') : {}), async (sent) => {
    await assert.rejects(confirmUpload({ userId: 7, purpose: 'general', key: KEY }), e => e.code === 'FORMAT_NOT_ALLOWED')
    assert.equal(sent.at(-1).constructor.name, 'DeleteObjectCommand')
  })
  await withR2(cmd => (cmd.constructor.name === 'GetObjectCommand' ? objectResponse(JPEG, 30 * MB, 'image/jpeg') : {}), async (sent) => {
    await assert.rejects(confirmUpload({ userId: 7, purpose: 'general', key: KEY }), e => e.code === 'FORMAT_NOT_ALLOWED')
    assert.equal(sent.at(-1).constructor.name, 'DeleteObjectCommand')
  })
})
