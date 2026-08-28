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

// ─────────────────────────────────────────────
// Email de vérification d'un nouvel appareil
// ─────────────────────────────────────────────
async function sendNewDeviceEmail(to, { deviceName, date, trustLink, rejectLink }) {
  await resend.emails.send({
    from: FROM,
    to,
    subject: '🔐 Nouvelle connexion détectée — LSBookers',
    html: `
      <div style="font-family:Arial,sans-serif;background:#0f0f13;color:#e8e8f0;padding:40px;border-radius:12px;max-width:560px;margin:0 auto">

        <div style="text-align:center;margin-bottom:32px">
          <div style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#a855f7);border-radius:12px;padding:12px 24px">
            <span style="font-weight:900;font-size:18px;letter-spacing:2px;color:white">LS Bookers</span>
          </div>
        </div>

        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:24px;margin-bottom:24px">
          <p style="color:#9090b0;margin:0 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:1px">Nouvelle connexion détectée</p>
          <h2 style="color:#ffffff;margin:0 0 16px 0;font-size:20px">Un nouvel appareil s'est connecté à votre compte</h2>
          <div style="display:flex;gap:12px;align-items:flex-start">
            <div style="background:#7c3aed;border-radius:8px;padding:8px 12px;font-size:20px;line-height:1">🖥️</div>
            <div>
              <p style="color:#ffffff;margin:0;font-weight:600">${deviceName}</p>
              <p style="color:#9090b0;margin:4px 0 0 0;font-size:13px">${date}</p>
            </div>
          </div>
        </div>

        <p style="color:#9090b0;line-height:1.6;margin-bottom:28px">
          Si c'était bien vous, confirmez cet appareil pour ne plus recevoir ces alertes.
          <br/>Si ce n'était <strong style="color:#f87171">pas vous</strong>, sécurisez immédiatement votre compte.
        </p>

        <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:28px">
          <a href="${trustLink}"
             style="display:block;background:#7c3aed;color:#fff;padding:16px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;text-align:center">
            ✓ C'était moi — Confirmer l'appareil
          </a>
          <a href="${rejectLink}"
             style="display:block;background:#1a1a2e;color:#f87171;padding:16px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;text-align:center;border:1px solid #7f1d1d">
            ✗ Ce n'était pas moi — Sécuriser mon compte
          </a>
        </div>

        <div style="background:#0f1a0f;border:1px solid #1a3a1a;border-radius:8px;padding:16px;margin-bottom:24px">
          <p style="color:#6ee7b7;margin:0;font-size:13px;line-height:1.5">
            <strong>⚠️ Important :</strong> Ces liens expirent dans 24h.
            Si vous cliquez sur "Ce n'était pas moi", toutes vos sessions seront fermées
            et vous serez invité à changer votre mot de passe.
          </p>
        </div>

        <hr style="border:none;border-top:1px solid #2a2a3a;margin:24px 0"/>
        <p style="color:#3a3a5a;font-size:11px;text-align:center">
          © ${new Date().getFullYear()} LSBookers — Plateforme de booking événementiel<br/>
          Vous recevez cet email car une connexion a été détectée sur votre compte.
        </p>
      </div>
    `,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendNewDeviceEmail };
