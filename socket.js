/**
 * socket.js — Singleton Socket.io
 * Initialise une fois depuis server.js, accessible depuis toutes les routes via getIO()
 */

const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')
const prisma = require('./prisma/client')

let io = null

// Rate limit typing en mémoire — max 1 event/s par userId (pas de Redis nécessaire)
const typingLastSent = new Map() // userId → timestamp

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
      const token = socket.handshake.auth?.token
      if (!token) return next(new Error('Unauthorized: no token'))
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      const userId = Number(decoded.id || decoded.userId)
      if (!userId) return next(new Error('Unauthorized: invalid token'))

      // Vérifier que l'utilisateur existe, est actif et que sa session est toujours valide
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, emailVerified: true, requiresPasswordReset: true, tokenVersion: true },
      })
      if (!user) return next(new Error('Unauthorized: user not found'))
      if (!user.emailVerified) return next(new Error('Unauthorized: email not verified'))
      if (user.requiresPasswordReset) return next(new Error('Unauthorized: password reset required'))
      // Point 1 — tokenVersion : rejeter les anciens JWT révoqués (ex: après changement de mdp)
      if (!Number.isInteger(decoded.tokenVersion) || decoded.tokenVersion !== user.tokenVersion) {
        return next(new Error('Unauthorized: session revoked'))
      }

      socket.userId = userId
      next()
    } catch {
      next(new Error('Unauthorized: token invalid or expired'))
    }
  })

  io.on('connection', (socket) => {
    // Chaque utilisateur rejoint automatiquement sa salle personnelle
    socket.join(`user:${socket.userId}`)

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
      // Socket.io gère le nettoyage automatiquement
    })
  })

  return io
}

function getIO() {
  if (!io) throw new Error('Socket.io non initialisé — appelez init() depuis server.js')
  return io
}

module.exports = { init, getIO }
