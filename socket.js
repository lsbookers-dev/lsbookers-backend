/**
 * socket.js — Singleton Socket.io
 * Initialise une fois depuis server.js, accessible depuis toutes les routes via getIO()
 */

const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')
const prisma = require('./prisma/client')

let io = null

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

      // Point 2 — Vérifier que l'utilisateur existe encore en base
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, emailVerified: true },
      })
      if (!user) return next(new Error('Unauthorized: user not found'))

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
    socket.on('typing', ({ conversationId, isTyping }) => {
      if (typeof conversationId !== 'number' || conversationId <= 0) return
      // Émettre à tous sauf l'expéditeur
      socket.to(`conv:${conversationId}`).emit('typing', {
        conversationId,
        userId: socket.userId,
        isTyping: !!isTyping,
      })
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
