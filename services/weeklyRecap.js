// services/weeklyRecap.js — Récap e-mail du lundi (option à activer dans Réglages)
// Envoyé le lundi à partir de 8 h (heure de Paris), une fois par semaine, et seulement
// s'il y a quelque chose à raconter.

const prisma = require('../prisma/client')
const { deliverEmail, FROM, APP_URL } = require('../utils/email')
const { artistPrestations, organizerEvents } = require('./prestations')
const { frenchDate } = require('./publicPerson')

const DAY = 24 * 60 * 60 * 1000

function parisClock(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  return { weekday: parts.find(p => p.type === 'weekday')?.value, hour: Number(parts.find(p => p.type === 'hour')?.value) }
}

const escape = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const euro = (n) => `${Math.round(n).toLocaleString('fr-FR').replace(/ /g, ' ')} €`

/** Contenu du récap d'un profil (null si rien à dire). */
async function buildRecap(profile, now) {
  const weekAgo = new Date(now.getTime() - 7 * DAY)
  const inAWeek = new Date(now.getTime() + 7 * DAY)
  const organizer = profile.user.role === 'ORGANIZER'

  const [dates, views, followers, reviews, offers, pending] = await Promise.all([
    organizer ? organizerEvents(profile.id, { from: now, to: inAWeek }) : artistPrestations(profile.id, { from: now, to: inAWeek }),
    prisma.profileView.count({ where: { profileId: profile.id, createdAt: { gte: weekAgo } } }),
    prisma.follow.count({ where: { followingId: profile.userId, createdAt: { gte: weekAgo } } }),
    prisma.review.count({ where: { targetId: profile.id, createdAt: { gte: weekAgo }, OR: [{ bookingId: { not: null } }, { staffId: { not: null } }] } }),
    organizer ? 0 : prisma.offer.count({ where: { status: 'ACTIVE', createdAt: { gte: weekAgo }, type: { in: [profile.user.role, 'ALL'] } } }),
    prisma.bookingRequest.count({ where: { status: 'PENDING', startDate: { gte: now }, ...(organizer ? { requesterId: profile.id } : { targetId: profile.id }) } }),
  ])
  if (!dates.length && !views && !followers && !reviews && !offers && !pending) return null
  return { organizer, dates, views, followers, reviews, offers, pending }
}

function recapHtml(name, r) {
  const stat = (value, label) => `<td style="padding:12px;background:#1a1824;border-radius:10px;text-align:center"><div style="font-size:22px;font-weight:700;color:#fff">${value}</div><div style="font-size:12px;color:#9d97ab">${label}</div></td>`
  const dates = r.dates.length
    ? r.dates.map(d => `<tr><td style="padding:8px 0;border-top:1px solid #26232f;color:#fff">${escape(frenchDate(d.date))}</td><td style="padding:8px 0;border-top:1px solid #26232f;color:#c4b5fd">${escape(d.title)}</td><td style="padding:8px 0;border-top:1px solid #26232f;text-align:right;color:#e8cf9c">${d.amount ? euro(d.amount) : ''}</td></tr>`).join('')
    : `<tr><td style="padding:8px 0;color:#9d97ab">Aucune date cette semaine.</td></tr>`
  return `
  <div style="font-family:Arial,sans-serif;background:#0b0a10;color:#f5f2fb;padding:32px;border-radius:14px;max-width:560px;margin:0 auto">
    <p style="margin:0;color:#a78bfa;font-size:12px;letter-spacing:2px;text-transform:uppercase">Votre semaine sur LS Bookers</p>
    <h1 style="margin:6px 0 20px;font-size:24px;color:#fff">Bonjour ${escape(name)},</h1>
    <h2 style="font-size:15px;color:#fff;margin:0 0 8px">${r.organizer ? 'Vos événements des 7 prochains jours' : 'Vos dates des 7 prochains jours'}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:22px">${dates}</table>
    <table style="width:100%;border-collapse:separate;border-spacing:8px;margin:0 -8px 18px"><tr>
      ${stat(r.views, 'vues du profil')}${stat(r.followers, 'nouveaux abonnés')}${stat(r.reviews, 'avis reçus')}
    </tr></table>
    ${r.pending ? `<p style="margin:0 0 8px;color:#e8cf9c">${r.pending} demande${r.pending > 1 ? 's' : ''} de booking en attente de réponse.</p>` : ''}
    ${r.offers ? `<p style="margin:0 0 8px;color:#c4b5fd">${r.offers} nouvelle${r.offers > 1 ? 's' : ''} offre${r.offers > 1 ? 's' : ''} publiée${r.offers > 1 ? 's' : ''} cette semaine.</p>` : ''}
    <p style="margin:22px 0"><a href="${APP_URL}/space" style="display:inline-block;background:#8b5cf6;color:#fff;padding:13px 22px;border-radius:10px;text-decoration:none;font-weight:700">Ouvrir Mon espace</a></p>
    <p style="font-size:11px;color:#6f6a7a;margin:0">Vous recevez ce récap car vous l'avez activé. Pour l'arrêter : Réglages → E-mails, sur ${APP_URL.replace(/^https?:\/\//, '')}.</p>
  </div>`
}

async function sendWeeklyRecaps(now = new Date()) {
  const { weekday, hour } = parisClock(now)
  if (weekday !== 'Mon' || hour < 8) return 0

  const profiles = await prisma.profile.findMany({
    where: {
      weeklyRecap: true,
      OR: [{ lastWeeklyRecapAt: null }, { lastWeeklyRecapAt: { lt: new Date(now.getTime() - 6 * DAY) } }],
      user: { emailVerified: true },
    },
    select: { id: true, userId: true, showRealName: true, user: { select: { email: true, role: true, pseudo: true, firstName: true } } },
    take: 200,
  })

  let sent = 0
  for (const profile of profiles) {
    try {
      const recap = await buildRecap(profile, now)
      if (recap) {
        await deliverEmail({
          from: FROM,
          to: profile.user.email,
          subject: 'Votre semaine sur LS Bookers',
          html: recapHtml(profile.user.pseudo || profile.user.firstName || 'à vous', recap),
        })
        sent++
      }
      await prisma.profile.update({ where: { id: profile.id }, data: { lastWeeklyRecapAt: now } })
    } catch (err) {
      console.error(`❌ Récap hebdo profil ${profile.id} :`, err.message)
    }
  }
  if (sent) console.log(`📬 ${sent} récap(s) de la semaine envoyé(s)`)
  return sent
}

module.exports = { sendWeeklyRecaps, buildRecap, recapHtml, parisClock }
