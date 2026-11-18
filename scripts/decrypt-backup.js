// Déchiffre une sauvegarde « .dump.enc » téléchargée depuis l'espace R2 lsbookers-backups.
// Usage : BACKUP_ENCRYPTION_KEY=<la clé> node scripts/decrypt-backup.js fichier.dump.enc [fichier.dump]
// La clé est celle renseignée dans Railway (et gardée par Antho dans son gestionnaire de mots de passe).
const fs = require('fs')
const { encryptionKey, decryptBackup } = require('../services/dbBackup')

const [input, output = String(input || '').replace(/\.enc$/, '')] = process.argv.slice(2)
if (!input || output === input) {
  console.error('Usage : BACKUP_ENCRYPTION_KEY=… node scripts/decrypt-backup.js fichier.dump.enc [fichier.dump]')
  process.exit(1)
}
try {
  const key = encryptionKey()
  if (!key) throw new Error('BACKUP_ENCRYPTION_KEY manquante')
  fs.writeFileSync(output, decryptBackup(fs.readFileSync(input), key))
  console.log(`Sauvegarde déchiffrée : ${output} (à restaurer avec pg_restore, voir scripts/RESTAURER.md)`)
} catch (err) {
  console.error('Déchiffrement impossible :', err.message)
  process.exit(1)
}
