/**
 * socket.js — Singleton Socket.io
 * Initialise une fois depuis server.js, accessible depuis toutes les routes via getIO()
 */

const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')

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

  // ── Authentification JWT sur chaque connexion socket ──
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token
      if (!token) return next(new Error('Unauthorized: no token'))
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      socket.userId = Number(decoded.id || decoded.userId)
      if (!socket.userId) return next(new Error('Unauthorized: invalid token'))
      next()
    } catch {
      next(new Error('Unauthorized: token invalid or expired'))
    }
  })

  io.on('connection', (socket) => {
    // Chaque utilisateur rejoint automatiquement sa salle personnelle
    socket.join(`user:${socket.userId}`)

    // Rejoindre une conversation (pour recevoir les nouveaux messages)
    socket.on('join_conversation', (conversationId) => {
      if (typeof conversationId === 'number' && conversationId > 0) {
        socket.join(`conv:${conversationId}`)
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
