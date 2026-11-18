// Sauvegardes chiffrées (audit du 18/11/2026)
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { encryptionKey, encryptBackup, decryptBackup } = require('../services/dbBackup')

test('sauvegarde : chiffrée puis déchiffrée à l’identique avec la bonne clé', () => {
  const key = crypto.randomBytes(32)
  const dump = crypto.randomBytes(5000)
  const enc = encryptBackup(dump, key)
  assert.notDeepEqual(enc.subarray(33, 133), dump.subarray(0, 100))
  assert.deepEqual(decryptBackup(enc, key), dump)
})

test('sauvegarde : une mauvaise clé ou un fichier modifié est refusé', () => {
  const key = crypto.randomBytes(32)
  const enc = encryptBackup(Buffer.from('données'), key)
  assert.throws(() => decryptBackup(enc, crypto.randomBytes(32)))
  const altered = Buffer.from(enc); altered[altered.length - 1] ^= 1
  assert.throws(() => decryptBackup(altered, key))
  assert.throws(() => decryptBackup(Buffer.from('pas une sauvegarde'), key), /pas une sauvegarde chiffrée/)
})

test('sauvegarde : clé absente = pas de chiffrement, clé mal formée = erreur claire', () => {
  assert.equal(encryptionKey(''), null)
  assert.equal(encryptionKey(undefined), null)
  assert.equal(encryptionKey('ab'.repeat(32)).length, 32)
  assert.throws(() => encryptionKey('trop-courte'), /64 caractères/)
})
