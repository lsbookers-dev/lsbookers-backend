const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const adminMiddleware = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } })

    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: 'Accès interdit ❌' })
    }

    next()
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Erreur serveur' })
  }
}

module.exports = adminMiddleware