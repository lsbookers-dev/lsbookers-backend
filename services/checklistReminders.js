// services/checklistReminders.js — Rappels de checklist, selon le choix de l'utilisateur
// (aucun, J-7 et veille, veille, J-7, ou une date choisie), s'il reste des éléments à cocher.

const prisma = require('../prisma/client')
const { createNotif } = require('./notifications')
const { frenchDate } = require('./publicPerson')

const DAY = 24 * 60 * 60 * 1000

async function sendChecklistReminders(now = new Date()) {
  const custom = await sendCustomReminders(now)
  const checklists = await prisma.eventChecklist.findMany({
    where: {
      remindMode: { in: ['J7_J1', 'J1', 'J7'] },
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
    // Rappel choisi : la veille seulement, ou une semaine avant seulement
    if ((c.remindMode === 'J1' && !inLastDay) || (c.remindMode === 'J7' && inLastDay)) continue
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
  return sent + custom
}

// Rappel à une date choisie par l'utilisateur (envoyé une fois, à partir de cette date)
async function sendCustomReminders(now) {
  const due = await prisma.eventChecklist.findMany({
    where: { remindMode: 'CUSTOM', remindAt: { lte: now }, remindedAt: null, items: { some: { done: false } }, event: { status: { not: 'CANCELLED' }, start: { gt: now } } },
    include: { event: { select: { id: true, title: true, start: true } }, profile: { select: { userId: true } }, items: { where: { done: false }, select: { id: true } } },
  })
  for (const c of due) {
    const left = c.items.length
    await createNotif({
      userId: c.profile.userId,
      type: 'CHECKLIST_REMINDER',
      content: `Rappel : il reste ${left} élément${left > 1 ? 's' : ''} à cocher dans votre checklist pour « ${c.event.title} » du ${frenchDate(c.event.start)}`,
      eventId: c.event.id,
    })
    await prisma.eventChecklist.update({ where: { id: c.id }, data: { remindedAt: now } })
  }
  return due.length
}

module.exports = { sendChecklistReminders }
