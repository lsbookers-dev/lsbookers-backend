// scripts/seed-local-accounts.js — Comptes de TEST pour une base PostgreSQL LOCALE uniquement.
// Usage : DATABASE_URL=postgresql://postgres@127.0.0.1:5433/lsb_test node scripts/seed-local-accounts.js
// Refuse de tourner sur autre chose que localhost (jamais sur la base Railway de production).
const bcrypt = require('bcrypt')

const url = process.env.DATABASE_URL || ''
if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
  console.error('❌ Refusé : ce script ne s\'exécute que sur une base locale (127.0.0.1 / localhost).')
  process.exit(1)
}

const prisma = require('../prisma/client')

// Mot de passe commun des comptes de test locaux
const TEST_PASSWORD = 'LocalTest-2026!'
const USERS = [
  { email: 'artiste.test@lsbookers.test', pseudo: 'artiste_test', role: 'ARTIST', profession: 'DJ' },
  { email: 'orga.test@lsbookers.test', pseudo: 'orga_test', role: 'ORGANIZER', profession: 'Organisateur' },
]

;(async () => {
  const password = await bcrypt.hash(TEST_PASSWORD, 10)
  for (const u of USERS) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email, password, role: u.role, pseudo: u.pseudo,
        firstName: 'Test', lastName: u.role, emailVerified: true, registrationStep: 4,
        profile: { create: { profession: u.profession, location: 'Paris', country: 'France' } },
      },
    })
    console.log(`✅ ${u.email} (id ${user.id})`)
  }
  await prisma.$disconnect()
})()
