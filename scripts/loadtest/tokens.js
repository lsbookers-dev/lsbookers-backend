// scripts/loadtest/tokens.js — Recalcule les jetons de connexion des 1000 membres virtuels du test de charge.
//   JWT_SECRET=<secret du serveur de TEST> node tokens.js > tokens.csv
// Les membres de test ont les numéros 1 à 1000 (base vide au départ) et la session sid = HMAC(secret, « loadtest-<id> »).
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const SECRET = process.env.JWT_SECRET
if (!SECRET) throw new Error('JWT_SECRET du serveur de test requis')
const roleOf = (i) => (i <= 500 ? 'ARTIST' : i <= 800 ? 'ORGANIZER' : 'PROVIDER')
console.log('id,token')
for (let id = 1; id <= 1000; id++) {
  const sid = crypto.createHmac('sha256', SECRET).update(`loadtest-${id}`).digest('hex').slice(0, 48)
  const token = jwt.sign({ id, email: `membre${id}@test-charge.invalid`, role: roleOf(id), isAdmin: false, tokenVersion: 0, sid }, SECRET, { expiresIn: '3d' })
  console.log(`${id},${token}`)
}
