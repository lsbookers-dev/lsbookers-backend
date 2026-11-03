// scripts/loadtest/seed.js — Fausses données pour le TEST DE CHARGE (étape 7 de la roadmap).
// Ne tourne QUE sur le serveur du projet Railway séparé « lsbookers-test-charge » (LOADTEST=1),
// jamais sur la production. Lancé au démarrage du serveur de test (commande de démarrage du projet de test),
// il ne fait rien si la base contient déjà des membres.
// Sessions : sid = HMAC(JWT_SECRET du serveur de TEST, « loadtest-<id> ») → jetons recalculables par tokens.js.
const crypto = require('crypto')
const { PrismaClient } = require('@prisma/client')

if (process.env.LOADTEST !== '1' || process.env.RAILWAY_PROJECT_NAME !== 'lsbookers-test-charge') {
  throw new Error('Script réservé au projet de test de charge : arrêt par sécurité')
}
const prisma = new PrismaClient()
const SECRET = process.env.JWT_SECRET
const loadtestSid = (id) => crypto.createHmac('sha256', SECRET).update(`loadtest-${id}`).digest('hex').slice(0, 48)

const N = 1000
const CITIES = [
  ['Paris', 48.8566, 2.3522], ['Marseille', 43.2964, 5.3778], ['Lyon', 45.7578, 4.832], ['Toulouse', 43.6047, 1.4442],
  ['Nice', 43.7102, 7.262], ['Nantes', 47.2184, -1.5536], ['Bordeaux', 44.8378, -0.5792], ['Lille', 50.6292, 3.0573],
  ['Montpellier', 43.6108, 3.8767], ['Strasbourg', 48.5734, 7.7521], ['Rennes', 48.1173, -1.6778], ['Toulon', 43.1242, 5.928],
  ['Aix-en-Provence', 43.5297, 5.4474], ['Grenoble', 45.1885, 5.7245], ['Dijon', 47.322, 5.0415],
]
const SPECIALTIES = ['DJ', 'Chanteur', 'Musicien', 'Groupe', 'Danseur', 'Humoriste', 'Magicien']
const PROVIDER_TYPES = ['Son', 'Lumière', 'Photographe', 'Vidéaste', 'Traiteur', 'Sécurité']
const STYLES = ['House', 'Techno', 'Jazz', 'Rock', 'Pop', 'Rap', 'Variété', 'Funk']
const ESTABLISHMENTS = ['Club', 'Bar', 'Salle de concert', 'Festival', 'Restaurant', 'Hôtel']
const MEDIA = 'https://media.lsbookers.com/lsbookers/media/1789763713078-Fond_Landing_1.png'
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const sample = (n, max, exclude) => { const s = new Set(); while (s.size < n) { const v = 1 + Math.floor(Math.random() * max); if (v !== exclude) s.add(v) } return [...s] }
const chunks = async (rows, size, fn) => { for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size)) }

;(async () => {
  console.time('remplissage')
  if (await prisma.user.count()) { console.log('Base de test déjà remplie : rien à faire'); return }
  const password = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8.Gx4W7tOQhH8o2D3/JZ1QpZr2l9yK' // empreinte factice, connexion par mot de passe impossible

  // 1. Membres + profils
  const users = Array.from({ length: N }, (_, i) => {
    const role = i < 500 ? 'ARTIST' : i < 800 ? 'ORGANIZER' : 'PROVIDER'
    return { email: `membre${i + 1}@test-charge.invalid`, password, role, pseudo: `Membre${i + 1}`, firstName: 'Test', lastName: `N${i + 1}`, emailVerified: true, registrationStep: 5 }
  })
  await chunks(users, 500, (rows) => prisma.user.createMany({ data: rows }))
  const dbUsers = await prisma.user.findMany({ select: { id: true, role: true, email: true, tokenVersion: true, isAdmin: true }, orderBy: { id: 'asc' } })
  await chunks(dbUsers, 500, (rows) => prisma.profile.createMany({ data: rows.map((u) => {
    const [city, lat, lon] = pick(CITIES)
    return {
      userId: u.id, location: city, city, country: 'France', latitude: lat + (Math.random() - 0.5) * 0.2, longitude: lon + (Math.random() - 0.5) * 0.2,
      bio: 'Profil fictif pour le test de charge.', avatar: MEDIA,
      specialties: u.role === 'ARTIST' ? [pick(SPECIALTIES)] : u.role === 'PROVIDER' ? [pick(PROVIDER_TYPES)] : [],
      styles: u.role === 'ARTIST' ? [pick(STYLES), pick(STYLES)] : [],
      typeEtablissement: u.role === 'ORGANIZER' ? pick(ESTABLISHMENTS) : null,
    }
  }) }))
  const profiles = await prisma.profile.findMany({ select: { id: true, userId: true }, orderBy: { id: 'asc' } })
  const profileOf = new Map(profiles.map((p) => [p.userId, p.id]))
  const userIds = dbUsers.map((u) => u.id)
  const uid = (k) => userIds[k - 1]
  console.log(`${dbUsers.length} membres`)

  // 2. Abonnements (~20 par membre)
  const follows = []
  for (const u of userIds) for (const k of sample(20, N)) if (uid(k) !== u) follows.push({ followerId: u, followingId: uid(k) })
  await chunks(follows, 5000, (rows) => prisma.follow.createMany({ data: rows, skipDuplicates: true }))
  console.log(`${follows.length} abonnements`)

  // 3. Publications (3 par membre) et j'aime (~10 par publication)
  const pubs = []
  for (const p of profiles) for (let j = 0; j < 3; j++) pubs.push({ title: `Publication ${j + 1}`, media: MEDIA, mediaType: 'image', caption: 'Publication fictive', profileId: p.id, createdAt: new Date(Date.now() - Math.random() * 60 * 86400e3) })
  await chunks(pubs, 3000, (rows) => prisma.publication.createMany({ data: rows }))
  const pubIds = (await prisma.publication.findMany({ select: { id: true } })).map((p) => p.id)
  const likes = []
  for (const id of pubIds) for (const k of sample(10, N)) likes.push({ publicationId: id, profileId: profileOf.get(uid(k)) })
  await chunks(likes, 5000, (rows) => prisma.publicationLike.createMany({ data: rows, skipDuplicates: true }))
  console.log(`${pubIds.length} publications, ${likes.length} j'aime`)

  // 4. Conversations (5 par membre, 20 messages chacune)
  let convCount = 0
  let msgCount = 0
  for (let i = 0; i < N; i += 2) {
    const a = uid(i + 1)
    for (const k of sample(5, N, i + 1)) {
      const b = uid(k)
      const conv = await prisma.conversation.create({ data: { participants: { create: [{ userId: a }, { userId: b }] } } })
      const msgs = Array.from({ length: 20 }, (_, m) => ({ conversationId: conv.id, senderId: m % 2 ? a : b, content: `Message fictif ${m + 1}`, seen: m < 18, createdAt: new Date(Date.now() - (20 - m) * 3600e3) }))
      await prisma.message.createMany({ data: msgs })
      convCount++; msgCount += msgs.length
    }
  }
  console.log(`${convCount} conversations, ${msgCount} messages`)

  // 5. Offres actives (organisateurs)
  const organizers = dbUsers.filter((u) => u.role === 'ORGANIZER')
  const offers = organizers.map((u) => ({ title: `Offre fictive de ${u.email.split('@')[0]}`, description: 'Offre pour le test de charge', type: pick(['ARTIST', 'PROVIDER', 'ALL']), specialty: Math.random() < 0.5 ? pick(SPECIALTIES) : null, date: new Date(Date.now() + (5 + Math.random() * 90) * 86400e3), location: pick(CITIES)[0], country: 'France', organizerId: profileOf.get(u.id) }))
  await prisma.offer.createMany({ data: offers })
  console.log(`${offers.length} offres`)

  // 6. Notifications (20 par membre)
  const notifs = []
  for (const u of userIds) for (let j = 0; j < 20; j++) notifs.push({ userId: u, type: pick(['NEW_FOLLOW', 'NEW_LIKE', 'NEW_COMMENT', 'NEW_OFFER']), content: 'Notification fictive', read: j > 3, actorId: uid(1 + Math.floor(Math.random() * N)) })
  await chunks(notifs, 5000, (rows) => prisma.notification.createMany({ data: rows }))
  console.log(`${notifs.length} notifications`)

  // 7. Sessions + jetons de connexion des membres virtuels
  const sessions = dbUsers.map((u) => ({ userId: u.id, sid: loadtestSid(u.id), name: 'Test de charge' }))
  await chunks(sessions, 1000, (rows) => prisma.userSession.createMany({ data: rows }))
  console.log(`${sessions.length} sessions de test créées`)
  console.timeEnd('remplissage')
})().catch((e) => { console.error('ERREUR', e.message); process.exitCode = 1 }).finally(() => prisma.$disconnect())
