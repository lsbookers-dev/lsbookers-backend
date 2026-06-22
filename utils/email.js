/**
 * utils/email.js
 * Service d'envoi d'emails via Resend
 */

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'LSBookers <noreply@lsbookers.com>';
const APP_URL = process.env.APP_URL || 'https://www.lsbookers.com';

// ─────────────────────────────────────────────
// Email de verification de compte
// ─────────────────────────────────────────────
async function sendVerificationEmail(to, token) {
  const link = `${APP_URL}/verify-email?token=${token}`;

  await resend.emails.send({
    from: FROM,
    to,
    subject: 'Confirme ton adresse email — LSBookers',
    html: `
      <div style="font-family:Arial,sans-serif;background:#0f0f13;color:#e8e8f0;padding:40px;border-radius:12px;max-width:560px;margin:0 auto">
        <div style="text-align:center;margin-bottom:32px">
          <div style="display:inline-block;background:linear-gradient(135deg,#10b981,#6366f1);border-radius:12px;padding:12px 20px">
            <span style="font-weight:900;font-size:18px;letter-spacing:2px;color:white">LS Bookers</span>
          </div>
        </div>
        <h2 style="color:#ffffff;margin-bottom:12px">Confirme ton adresse email</h2>
        <p style="color:#9090b0;line-height:1.6">
          Merci de t'être inscrit sur LSBookers. Clique sur le bouton ci-dessous pour activer ton compte.
        </p>
        <div style="text-align:center;margin:32px 0">
          <a href="${link}" style="display:inline-block;background:#10b981;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">
            Confirmer mon email
          </a>
        </div>
        <p style="color:#5a5a7a;font-size:13px">
          Ce lien est valable 24h. Si tu n'es pas à l'origine de cette inscription, ignore cet email.
        </p>
        <hr style="border:none;border-top:1px solid #2a2a3a;margin:24px 0"/>
        <p style="color:#3a3a5a;font-size:11px;text-align:center">
          © ${new Date().getFullYear()} LSBookers — Plateforme de booking événementiel
        </p>
      </div>
    `,
  });
}

// ─────────────────────────────────────────────
// Email de réinitialisation de mot de passe
// ─────────────────────────────────────────────
async function sendPasswordResetEmail(to, token) {
  const link = `${APP_URL}/reset-password?token=${token}`;

  await resend.emails.send({
    from: FROM,
    to,
    subject: 'Réinitialise ton mot de passe — LSBookers',
    html: `
      <div style="font-family:Arial,sans-serif;background:#0f0f13;color:#e8e8f0;padding:40px;border-radius:12px;max-width:560px;margin:0 auto">
        <div style="text-align:center;margin-bottom:32px">
          <div style="display:inline-block;background:linear-gradient(135deg,#10b981,#6366f1);border-radius:12px;padding:12px 20px">
            <span style="font-weight:900;font-size:18px;letter-spacing:2px;color:white">LS Bookers</span>
          </div>
        </div>
        <h2 style="color:#ffffff;margin-bottom:12px">Réinitialise ton mot de passe</h2>
        <p style="color:#9090b0;line-height:1.6">
          Tu as demandé la réinitialisation de ton mot de passe. Clique sur le bouton ci-dessous (valable 1h).
        </p>
        <div style="text-align:center;margin:32px 0">
          <a href="${link}" style="display:inline-block;background:#10b981;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">
            Réinitialiser mon mot de passe
          </a>
        </div>
        <p style="color:#5a5a7a;font-size:13px">
          Si tu n'es pas à l'origine de cette demande, ignore cet email. Ton mot de passe ne sera pas modifié.
        </p>
        <hr style="border:none;border-top:1px solid #2a2a3a;margin:24px 0"/>
        <p style="color:#3a3a5a;font-size:11px;text-align:center">
          © ${new Date().getFullYear()} LSBookers — Plateforme de booking événementiel
        </p>
      </div>
    `,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
