// middlewares/verifyToken.js
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: Bearer <token>

  if (!token) {
    return res.status(401).json({ error: 'TOKEN_MANQUANT' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (!user) {
      return res.status(401).json({ error: 'UTILISATEUR_INVALIDE' });
    }

    req.user = user; // On attache l'utilisateur à la requête
    next();
  } catch (err) {
    console.error('Erreur JWT :', err);
    return res.status(403).json({ error: 'TOKEN_INVALIDE' });
  }
};

module.exports = verifyToken;