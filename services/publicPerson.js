// services/publicPerson.js — Identité publique d'un profil (respecte « afficher mon nom et prénom »)

const PERSON_SELECT = {
  id: true,
  avatar: true,
  showRealName: true,
  user: { select: { id: true, pseudo: true, firstName: true, lastName: true, role: true } },
}

function publicName(profile) {
  const u = profile?.user
  if (!u) return 'Utilisateur LSBookers'
  const realName = [u.firstName, u.lastName].filter(Boolean).join(' ')
  if (profile.showRealName && realName) return realName
  return u.pseudo || 'Utilisateur LSBookers'
}

// « 24 décembre 2026 », à l'heure de Paris
function frenchDate(date) {
  return new Date(date).toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris',
  })
}

module.exports = { PERSON_SELECT, publicName, frenchDate }
