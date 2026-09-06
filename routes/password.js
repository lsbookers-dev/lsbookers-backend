const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { sendPasswordResetEmail } = require('../utils/email');
const { validate } = require('../middleware/validate');
const { forgotPasswordSchema, resetPasswordSchema } = require('../schemas');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ─────────────────────────────────────────────
// ROUTE: /api/auth/forgot-password
// ─────────────────────────────────────────────
router.post('/forgot-password', validate(forgotPasswordSchema), async (req, res) => {
  const { email } = req.body;
  const generic = { message: 'Si un compte existe, un email sera envoye.' };

  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user) return res.status(200).json(generic);

    // Invalide les anciens tokens non utilises
    await prisma.passwordReset.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h

    await prisma.passwordReset.create({
      data: {
        id: crypto.randomBytes(16).toString('hex'),
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    sendPasswordResetEmail(user.email, token).catch(err =>
      console.error('Erreur envoi email reset:', err)
    );

    return res.status(200).json(generic);
  } catch (e) {
    console.error('forgot-password error', e);
    return res.status(200).json(generic);
  }
});

// ─────────────────────────────────────────────
// ROUTE: /api/auth/reset-password
// ─────────────────────────────────────────────
router.post('/reset-password', validate(resetPasswordSchema), async (req, res) => {
  const { token, password } = req.body;

  try {
    const tokenHash = sha256Hex(token);
    const pr = await prisma.passwordReset.findUnique({ where: { tokenHash } });

    if (!pr || pr.usedAt || pr.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Lien invalide ou expire.' });
    }

    const user = await prisma.user.findUnique({ where: { id: pr.userId }, select: { password: true } });
    if (user && await bcrypt.compare(password, user.password)) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit être différent de l\'ancien.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const resetApplied = await prisma.$transaction(async tx => {
      // Réclamer le lien dans la transaction empêche deux requêtes simultanées
      // de réutiliser le même jeton.
      const claimed = await tx.passwordReset.updateMany({
        where: {
          tokenHash,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });

      if (claimed.count !== 1) return false;

      await tx.user.update({
        where: { id: pr.userId },
        data: {
          password: hash,
          tokenVersion: { increment: 1 },
        },
      });
      return true;
    });

    if (!resetApplied) {
      return res.status(400).json({ error: 'Lien invalide ou expire.' });
    }

    return res.json({ message: 'Mot de passe reinitialise avec succes.' });
  } catch (e) {
    console.error('reset-password error', e);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
