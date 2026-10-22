// routes/invoices.js — Devis et factures
// Numérotation continue par émetteur, par type et par année (D-2026-001, F-2026-001),
// comme l'exige une facturation régulière. Un document envoyé n'est plus modifiable :
// on l'annule et on en crée un nouveau.
const express = require('express')
const router = express.Router()
const prisma = require('../prisma/client')
const { requireAuth } = require('../middleware/auth')
const { requirePro } = require('../lib/plan')
const { validate } = require('../middleware/validate')
const { invoiceSchema, invoiceStatusSchema } = require('../schemas')
const { PERSON_SELECT, publicName } = require('../services/publicPerson')

const PREFIX = { QUOTE: 'D', INVOICE: 'F' }
const STATUS_FLOW = {
  QUOTE: ['DRAFT', 'SENT', 'ACCEPTED', 'CANCELLED'],
  INVOICE: ['DRAFT', 'SENT', 'PAID', 'CANCELLED'],
}

const ISSUER_SELECT = {
  ...PERSON_SELECT,
  siret: true, legalStatus: true, establishmentName: true,
  address: true, postalCode: true, city: true, location: true, country: true,
}

const myProfile = (req) => prisma.profile.findUnique({ where: { userId: req.user.id }, select: { id: true } })

function totals(items, vatRate) {
  const ht = items.reduce((sum, i) => sum + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0)
  const vat = Math.round(ht * (vatRate || 0)) / 100
  return { ht: Math.round(ht * 100) / 100, vat, ttc: Math.round((ht + vat) * 100) / 100 }
}

function format(invoice) {
  const items = Array.isArray(invoice.items) ? invoice.items : []
  const issuer = invoice.issuer
  return {
    ...invoice,
    items,
    totals: totals(items, invoice.vatRate),
    issuer: issuer ? {
      profileId: issuer.id,
      name: publicName(issuer),
      legalName: [issuer.user?.firstName, issuer.user?.lastName].filter(Boolean).join(' ') || null,
      establishmentName: issuer.establishmentName || null,
      siret: issuer.siret || null,
      legalStatus: issuer.legalStatus || null,
      address: [issuer.address, [issuer.postalCode, issuer.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
      city: issuer.city || issuer.location || null,
    } : null,
    client: invoice.client ? { profileId: invoice.client.id, userId: invoice.client.user?.id ?? null, name: publicName(invoice.client) } : null,
  }
}

const INCLUDE = { issuer: { select: ISSUER_SELECT }, client: { select: PERSON_SELECT } }

async function nextNumber(issuerId, kind, year) {
  const prefix = `${PREFIX[kind]}-${year}-`
  const existing = await prisma.invoice.findMany({
    where: { issuerId, kind, number: { startsWith: prefix } },
    select: { number: true },
  })
  const n = existing.reduce((max, i) => Math.max(max, Number.parseInt(i.number.slice(prefix.length), 10) || 0), 0) + 1
  return `${prefix}${String(n).padStart(3, '0')}`
}

/** Vérifie un booking et un client facultatifs : ils doivent concerner l'émetteur. */
async function checkLinks(issuerId, { bookingId, clientProfileId }) {
  if (bookingId) {
    const booking = await prisma.bookingRequest.findUnique({ where: { id: bookingId }, select: { requesterId: true, targetId: true } })
    if (!booking || (booking.requesterId !== issuerId && booking.targetId !== issuerId)) return 'Booking introuvable'
  }
  if (clientProfileId) {
    const client = await prisma.profile.findUnique({ where: { id: clientProfileId }, select: { id: true } })
    if (!client) return 'Client introuvable'
  }
  return null
}

// GET /api/invoices — mes devis et factures (?kind=QUOTE|INVOICE)
router.get('/', requireAuth, requirePro, async (req, res) => {
  try {
    const me = await myProfile(req)
    if (!me) return res.status(404).json({ error: 'Profil introuvable' })
    const kind = ['QUOTE', 'INVOICE'].includes(req.query.kind) ? req.query.kind : undefined
    const invoices = await prisma.invoice.findMany({
      where: { issuerId: me.id, ...(kind ? { kind } : {}) },
      include: INCLUDE,
      orderBy: [{ issueDate: 'desc' }, { id: 'desc' }],
      take: 200,
    })
    res.set('Cache-Control', 'private, no-store')
    return res.json({ invoices: invoices.map(format) })
  } catch (err) {
    console.error('❌ GET /invoices :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// GET /api/invoices/:id — émetteur ou client
router.get('/:id', requireAuth, requirePro, async (req, res) => {
  try {
    const me = await myProfile(req)
    const invoice = await prisma.invoice.findUnique({ where: { id: Number.parseInt(req.params.id, 10) || 0 }, include: INCLUDE })
    if (!me || !invoice || (invoice.issuerId !== me.id && invoice.clientProfileId !== me.id)) {
      return res.status(404).json({ error: 'Document introuvable' })
    }
    res.set('Cache-Control', 'private, no-store')
    return res.json({ invoice: format(invoice) })
  } catch (err) {
    console.error('❌ GET /invoices/:id :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/invoices — créer un brouillon (le numéro est attribué tout de suite)
router.post('/', requireAuth, requirePro, validate(invoiceSchema), async (req, res) => {
  try {
    const me = await myProfile(req)
    if (!me) return res.status(404).json({ error: 'Profil introuvable' })
    const body = req.body
    const linkError = await checkLinks(me.id, body)
    if (linkError) return res.status(400).json({ error: linkError })

    const issueDate = body.issueDate ? new Date(body.issueDate) : new Date()
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const invoice = await prisma.invoice.create({
          data: {
            kind: body.kind,
            number: await nextNumber(me.id, body.kind, issueDate.getFullYear()),
            issuerId: me.id,
            clientProfileId: body.clientProfileId ?? null,
            clientName: body.clientName,
            clientAddress: body.clientAddress || null,
            bookingId: body.bookingId ?? null,
            title: body.title || null,
            serviceDate: body.serviceDate ? new Date(body.serviceDate) : null,
            items: body.items,
            vatRate: body.vatRate ?? 0,
            notes: body.notes || null,
            issueDate,
            dueDate: body.dueDate ? new Date(body.dueDate) : null,
          },
          include: INCLUDE,
        })
        return res.status(201).json({ invoice: format(invoice) })
      } catch (err) {
        if (err.code !== 'P2002') throw err // numéro pris entre-temps : on réessaie
      }
    }
    return res.status(409).json({ error: 'Numérotation occupée, réessayez.' })
  } catch (err) {
    console.error('❌ POST /invoices :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// PUT /api/invoices/:id — modifier un brouillon
router.put('/:id', requireAuth, requirePro, validate(invoiceSchema), async (req, res) => {
  try {
    const me = await myProfile(req)
    const id = Number.parseInt(req.params.id, 10) || 0
    const current = await prisma.invoice.findUnique({ where: { id }, select: { issuerId: true, status: true, kind: true } })
    if (!me || !current || current.issuerId !== me.id) return res.status(404).json({ error: 'Document introuvable' })
    if (current.status !== 'DRAFT') return res.status(409).json({ error: 'Un document envoyé ne peut plus être modifié. Annulez-le et créez-en un nouveau.' })
    const body = req.body
    const linkError = await checkLinks(me.id, body)
    if (linkError) return res.status(400).json({ error: linkError })
    const invoice = await prisma.invoice.update({
      where: { id },
      data: {
        clientProfileId: body.clientProfileId ?? null,
        clientName: body.clientName,
        clientAddress: body.clientAddress || null,
        bookingId: body.bookingId ?? null,
        title: body.title || null,
        serviceDate: body.serviceDate ? new Date(body.serviceDate) : null,
        items: body.items,
        vatRate: body.vatRate ?? 0,
        notes: body.notes || null,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
      },
      include: INCLUDE,
    })
    return res.json({ invoice: format(invoice) })
  } catch (err) {
    console.error('❌ PUT /invoices/:id :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// PATCH /api/invoices/:id/status — { status }
router.patch('/:id/status', requireAuth, requirePro, validate(invoiceStatusSchema), async (req, res) => {
  try {
    const me = await myProfile(req)
    const id = Number.parseInt(req.params.id, 10) || 0
    const current = await prisma.invoice.findUnique({ where: { id }, select: { issuerId: true, kind: true, status: true } })
    if (!me || !current || current.issuerId !== me.id) return res.status(404).json({ error: 'Document introuvable' })
    const { status } = req.body
    if (!STATUS_FLOW[current.kind].includes(status)) return res.status(400).json({ error: 'Statut impossible pour ce document' })
    if (status === 'DRAFT' && current.status !== 'DRAFT') return res.status(409).json({ error: 'Un document envoyé ne redevient pas brouillon.' })
    const invoice = await prisma.invoice.update({
      where: { id },
      data: { status, ...(status === 'SENT' ? { sentAt: new Date() } : {}) },
      include: INCLUDE,
    })
    return res.json({ invoice: format(invoice) })
  } catch (err) {
    console.error('❌ PATCH /invoices/:id/status :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// POST /api/invoices/:id/convert — transformer un devis en facture (nouveau brouillon)
router.post('/:id/convert', requireAuth, requirePro, async (req, res) => {
  try {
    const me = await myProfile(req)
    const quote = await prisma.invoice.findUnique({ where: { id: Number.parseInt(req.params.id, 10) || 0 } })
    if (!me || !quote || quote.issuerId !== me.id || quote.kind !== 'QUOTE') return res.status(404).json({ error: 'Devis introuvable' })
    const issueDate = new Date()
    const invoice = await prisma.invoice.create({
      data: {
        kind: 'INVOICE',
        number: await nextNumber(me.id, 'INVOICE', issueDate.getFullYear()),
        issuerId: me.id,
        clientProfileId: quote.clientProfileId,
        clientName: quote.clientName,
        clientAddress: quote.clientAddress,
        bookingId: quote.bookingId,
        title: quote.title,
        serviceDate: quote.serviceDate,
        items: quote.items,
        vatRate: quote.vatRate,
        notes: quote.notes ? `${quote.notes}\nSelon devis ${quote.number}.` : `Selon devis ${quote.number}.`,
        issueDate,
      },
      include: INCLUDE,
    })
    if (quote.status === 'SENT') await prisma.invoice.update({ where: { id: quote.id }, data: { status: 'ACCEPTED' } })
    return res.status(201).json({ invoice: format(invoice) })
  } catch (err) {
    console.error('❌ POST /invoices/:id/convert :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

// DELETE /api/invoices/:id — seulement un brouillon (sinon : annuler)
router.delete('/:id', requireAuth, requirePro, async (req, res) => {
  try {
    const me = await myProfile(req)
    const id = Number.parseInt(req.params.id, 10) || 0
    const current = await prisma.invoice.findUnique({ where: { id }, select: { issuerId: true, status: true } })
    if (!me || !current || current.issuerId !== me.id) return res.status(404).json({ error: 'Document introuvable' })
    if (current.status !== 'DRAFT') return res.status(409).json({ error: 'Seul un brouillon peut être supprimé. Annulez plutôt ce document.' })
    await prisma.invoice.delete({ where: { id } })
    return res.json({ ok: true })
  } catch (err) {
    console.error('❌ DELETE /invoices/:id :', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
})

module.exports = router
module.exports.totals = totals
