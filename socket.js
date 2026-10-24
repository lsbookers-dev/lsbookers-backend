/**
 * socket.js — Singleton Socket.io
 * Initialise une fois depuis server.js, accessible depuis toutes les routes via getIO()
 */

const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')
const prisma = require('./prisma/client')
const { tokenFromCookieHeader } = require('./lib/session')

let io = null

// Rate limit typing en mémoire — max 1 event/s par userId (pas de Redis nécessaire)
const typingLastSent = new Map() // userId → timestamp

// Présence « en ligne » : membres qui ont le site ouvert (au moins un onglet connecté).
// Leur « dernière activité » est rafraîchie ici, en une requête par minute pour tout le monde,
// au lieu d'un appel « je suis là » envoyé par chaque onglet.
// (Un seul serveur : à déplacer dans Redis le jour où il y en aura plusieurs, cf. #282.)
const openTabs = new Map() // userId → nombre d'onglets connectés
const PRESENCE_EVERY_MS = 60 * 1000

function touchUsers(userIds) {
  if (!userIds.length) return
  prisma.user.updateMany({ where: { id: { in: userIds } }, data: { lastActiveAt: new Date() } }).catch(() => {})
}

function isUserOnline(userId) {
  return (openTabs.get(Number(userId)) || 0) > 0
}

const ALLOWED_ORIGINS = [
  'https://www.lsbookers.com',
  'https://lsbookers.com',
  'http://localhost:3000',
  'http://localhost:3001',
]

function init(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 30000,
    pingInterval: 10000,
    // Limite la taille des payloads socket (évite les abus)
    maxHttpBufferSize: 1e6, // 1 MB
  })

  // ── Authentification JWT + vérification DB sur chaque connexion socket ──
  io.use(async (socket, next) => {
    try {
      // Jeton : envoyé explicitement (mode transition) ou cookie httpOnly (mode cookie uniquement)
      const token = socket.handshake.auth?.token || tokenFromCookieHeader(socket.handshake.headers?.cookie)
      if (!token) return next(new Error('Unauthorized: no token'))
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      const userId = Number(decoded.id || decoded.userId)
      if (!userId) return next(new Error('Unauthorized: invalid token'))

      // Vérifier que l'utilisateur existe, est actif et que sa session est toujours valide
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true, emailVerified: true, requiresPasswordReset: true, tokenVersion: true,
          ...(typeof decoded.sid === 'string' ? { sessions: { where: { sid: decoded.sid }, select: { revokedAt: true }, take: 1 } } : {}),
        },
      })
      if (!user) return next(new Error('Unauthorized: user not found'))
      if (!user.emailVerified) return next(new Error('Unauthorized: email not verified'))
      if (user.requiresPasswordReset) return next(new Error('Unauthorized: password reset required'))
      // Point 1 — tokenVersion : rejeter les anciens JWT révoqués (ex: après changement de mdp)
      if (!Number.isInteger(decoded.tokenVersion) || decoded.tokenVersion !== user.tokenVersion) {
        return next(new Error('Unauthorized: session revoked'))
      }
      // Appareil retiré dans les Réglages
      if (typeof decoded.sid === 'string' && (!user.sessions?.[0] || user.sessions[0].revokedAt)) {
        return next(new Error('Unauthorized: session revoked'))
      }

      socket.userId = userId
      next()
    } catch {
      next(new Error('Unauthorized: token invalid or expired'))
    }
  })

  setInterval(() => touchUsers([...openTabs.keys()]), PRESENCE_EVERY_MS).unref()

  io.on('connection', (socket) => {
    // Chaque utilisateur rejoint automatiquement sa salle personnelle
    socket.join(`user:${socket.userId}`)

    const tabs = (openTabs.get(socket.userId) || 0) + 1
    openTabs.set(socket.userId, tabs)
    if (tabs === 1) touchUsers([socket.userId])

    // Rejoindre une conversation (Point 1 — vérifier que l'utilisateur est bien participant)
    socket.on('join_conversation', async (conversationId) => {
      if (typeof conversationId !== 'number' || conversationId <= 0) return
      try {
        const participant = await prisma.conversationParticipant.findFirst({
          where: { conversationId, userId: socket.userId },
          select: { id: true },
        })
        if (!participant) return // Accès refusé silencieusement
        socket.join(`conv:${conversationId}`)
      } catch {
        // Erreur DB silencieuse — l'utilisateur ne rejoint simplement pas la room
      }
    })

    // Quitter une conversation (ex: fermeture de l'onglet)
    socket.on('leave_conversation', (conversationId) => {
      socket.leave(`conv:${conversationId}`)
    })

    // Indicateur de frappe — relayer aux autres membres de la conv
    socket.on('typing', (payload) => {
      try {
        // Validation stricte du payload pour éviter tout crash Node
        if (!payload || typeof payload !== 'object') return
        const { conversationId, isTyping } = payload
        if (typeof conversationId !== 'number' || conversationId <= 0) return

        // Point 3 — vérifier que le socket est bien dans cette room (= participant vérifié via join_conversation)
        if (!socket.rooms.has(`conv:${conversationId}`)) return

        // Rate limit : max 1 event typing/s par userId (anti-spam sans Redis)
        const now = Date.now()
        const last = typingLastSent.get(socket.userId) ?? 0
        if (now - last < 1000) return
        typingLastSent.set(socket.userId, now)

        // Émettre à tous sauf l'expéditeur
        socket.to(`conv:${conversationId}`).emit('typing', {
          conversationId,
          userId: socket.userId,
          isTyping: !!isTyping,
        })
      } catch {
        // Ne jamais laisser une exception tuer le process Node
      }
    })

    socket.on('disconnect', () => {
      // Les salles sont nettoyées par Socket.io ; dernier onglet fermé → « vu à l'instant »
      const left = (openTabs.get(socket.userId) || 1) - 1
      if (left > 0) return openTabs.set(socket.userId, left)
      openTabs.delete(socket.userId)
      typingLastSent.delete(socket.userId)
      touchUsers([socket.userId])
    })
  })

  return io
}

function getIO() {
  if (!io) throw new Error('Socket.io non initialisé — appelez init() depuis server.js')
  return io
}

module.exports = { init, getIO, isUserOnline }
