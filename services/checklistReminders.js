// services/checklistReminders.js — Rappels de checklist à J-7 et J-1
// Seulement pour les checklists ajoutées par l'utilisateur, s'il reste des éléments à cocher.

const prisma = require('../prisma/client')
const { createNotif } = require('./notifications')
const { frenchDate } = require('./publicPerson')

const DAY = 24 * 60 * 60 * 1000

async function sendChecklistReminders(now = new Date()) {
  const checklists = await prisma.eventChecklist.findMany({
    where: {
      event: { status: { not: 'CANCELLED' }, start: { gt: now, lte: new Date(now.getTime() + 7 * DAY) } },
      items: { some: { done: false } },
      OR: [{ reminded7At: null }, { reminded1At: null }],
    },
    include: {
      event: { select: { id: true, title: true, start: true } },
      profile: { select: { userId: true } },
      items: { where: { done: false }, select: { id: true } },
    },
  })

  let sent = 0
  for (const c of checklists) {
    const inLastDay = c.event.start.getTime() - now.getTime() <= DAY
    const field = inLastDay ? 'reminded1At' : 'reminded7At'
    if (c[field]) continue
    const left = c.items.length
    await createNotif({
      userId: c.profile.userId,
      type: 'CHECKLIST_REMINDER',
      content: `${inLastDay ? 'Demain' : 'Dans moins d’une semaine'} : il reste ${left} élément${left > 1 ? 's' : ''} à cocher dans votre checklist pour « ${c.event.title} » du ${frenchDate(c.event.start)}`,
      eventId: c.event.id,
    })
    // Le rappel J-1 rend inutile un J-7 pas encore envoyé
    await prisma.eventChecklist.update({
      where: { id: c.id },
      data: inLastDay ? { reminded1At: now, reminded7At: c.reminded7At || now } : { reminded7At: now },
    })
    sent++
  }
  if (sent) console.log(`🗒️ ${sent} rappel(s) de checklist envoyé(s)`)
  return sent
}

module.exports = { sendChecklistReminders }
