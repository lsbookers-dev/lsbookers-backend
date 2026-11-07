// services/nameLock.js — prénom et nom figés après l'inscription
// Modifiables librement pendant 7 jours (faute de frappe), puis seulement sur demande à l'équipe.
// Une identité vérifiée par Stripe (paiements) ne se modifie plus du tout par le membre.

const NAME_EDIT_DAYS = 7

function nameStatus(user, now = new Date()) {
  if (user?.isIdentityVerified) return { locked: true, reason: 'VERIFIED', editableUntil: null }
  const until = new Date(new Date(user?.createdAt || 0).getTime() + NAME_EDIT_DAYS * 864e5)
  if (now >= until) return { locked: true, reason: 'DELAY', editableUntil: null }
  return { locked: false, reason: null, editableUntil: until }
}

module.exports = { NAME_EDIT_DAYS, nameStatus }
