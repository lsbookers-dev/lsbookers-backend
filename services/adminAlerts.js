// services/adminAlerts.js — Notifications envoyées aux administrateurs (cloche de l'admin)
const prisma = require('../prisma/client')
const { createNotif } = require('./notifications')

async function notifyAdmins({ type, content, actorId }) {
  try {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
    await Promise.all(admins.map(a => createNotif({ userId: a.id, type, content, actorId })))
  } catch (err) {
    console.error('notifyAdmins:', err.message)
  }
}

module.exports = { notifyAdmins }
