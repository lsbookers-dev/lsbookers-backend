// Sauvegarde manuelle immédiate de la base (en plus de celle de chaque nuit).
// Sur Railway :  railway run node scripts/backup-now.js   (pg_dump 16 requis en local)
require('dotenv').config()
const { runBackup } = require('../services/dbBackup')
runBackup().then(r => { console.log('OK', r); process.exit(0) }).catch(e => { console.error('Échec :', e.message); process.exit(1) })
