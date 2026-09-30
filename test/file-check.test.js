const test = require('node:test')
const assert = require('node:assert/strict')
const { isFileContentValid, extensionFor } = require('../lib/fileCheck')

const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(32)])
const at4 = (box) => pad([0, 0, 0, 0x20, ...Buffer.from(box)])

const valid = {
  'image/jpeg': pad([0xff, 0xd8, 0xff, 0xe0]),
  'image/png': pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/gif': pad(Buffer.from('GIF89a')),
  'image/webp': pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])),
  'video/mp4': at4('ftypisom'),
  'video/quicktime': at4('ftypqt  '),
  'video/webm': pad([0x1a, 0x45, 0xdf, 0xa3]),
  'application/pdf': pad(Buffer.from('%PDF-1.7')),
  'audio/mpeg': pad(Buffer.from('ID3')),
  'audio/wav': pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])),
  'audio/ogg': pad(Buffer.from('OggS')),
}

for (const [mime, buf] of Object.entries(valid)) {
  test(`${mime} : un vrai fichier est accepté`, () => {
    assert.equal(isFileContentValid(buf, mime), true)
  })
}

test('une page HTML déguisée est refusée quel que soit le type annoncé', () => {
  const html = pad(Buffer.from('<html><script>alert(1)</script>'))
  for (const mime of Object.keys(valid)) assert.equal(isFileContentValid(html, mime), false, mime)
})

test('un type non prévu (SVG, HTML, exécutable) est refusé', () => {
  assert.equal(isFileContentValid(valid['image/png'], 'image/svg+xml'), false)
  assert.equal(isFileContentValid(valid['image/png'], 'text/html'), false)
  assert.equal(isFileContentValid(valid['image/png'], 'application/x-msdownload'), false)
})

test('un PNG annoncé comme JPEG est refusé', () => {
  assert.equal(isFileContentValid(valid['image/png'], 'image/jpeg'), false)
})

test('l\'extension vient du type vérifié, jamais du nom d\'origine', () => {
  assert.equal(extensionFor('image/jpeg'), 'jpg')
  assert.equal(extensionFor('video/quicktime'), 'mov')
  assert.equal(extensionFor('text/html'), 'bin')
})
