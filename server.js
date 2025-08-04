const express = require('express')
const cors = require('cors')

// ✅ Importation des routes
const authRoutes = require('./routes/auth')
const profileRoutes = require('./routes/profile')
const mediaRoutes = require('./routes/media')
const messageRoutes = require('./routes/message')
const followRoutes = require('./routes/follow')
const feedRoutes = require('./routes/feed')
const searchRoutes = require('./routes/search')
const usersRoutes = require('./routes/users')
const adminRoutes = require('./routes/admin')
const adminSettingsRoutes = require('./routes/adminSettings') // Routes design admin

const app = express()

// ✅ Middlewares globaux
app.use(cors())
app.use(express.json())

// ✅ Exposition du dossier "uploads" pour fichiers médias
app.use('/uploads', express.static('uploads'))

// ✅ Enregistrement des routes API
app.use('/api/auth', authRoutes)
app.use('/api/profile', profileRoutes)
app.use('/api/media', mediaRoutes)
app.use('/api/messages', messageRoutes)
app.use('/api/follow', followRoutes)
app.use('/api/feed', feedRoutes)
app.use('/api/search', searchRoutes)
app.use('/api', usersRoutes) // /api/users & /api/users/:id
app.use('/api/admin', adminRoutes)
app.use('/api/admin/settings', adminSettingsRoutes)

// ✅ Lancement du serveur (compatible Railway)
const PORT = process.env.PORT || 5001
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Serveur lancé sur http://0.0.0.0:${PORT}`)
})