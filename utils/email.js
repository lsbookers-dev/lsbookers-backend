/**
 * utils/email.js
 * Service d'envoi d'emails via Resend
 */

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'LSBookers <noreply@lsbookers.com>';
const APP_URL = (process.env.APP_URL || 'https://lsbookers.com').replace(/\/+$/, '');

async function deliverEmail(payload) {
  // Tests automatiques : aucun e-mail réel n'est jamais envoyé (voir « test » dans package.json)
  if (process.env.LSB_DISABLE_EMAILS === '1') return { data: { id: 'test' } }
  const result = await resend.emails.send(payload)
  if (result?.error) {
    throw new Error(result.error.message || 'Le fournisseur email a refusé l’envoi')
  }
  return result
}

// ─────────────────────────────────────────────
// Email de verification de compte
// ─────────────────────────────────────────────
async function sendVerificationEmail(to, token) {
  const link = `${APP_URL}/verify-email?token=${token}`;

  await deliverEmail({
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

  await deliverEmail({
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
  await deliverEmail({
    from: FROM,
    to,
    subject: 'Nouvelle connexion détectée — LS Bookers',
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
          <div style="border-left:3px solid #8b5cf6;padding-left:12px">
            <p style="color:#ffffff;margin:0;font-weight:600">${deviceName}</p>
            <p style="color:#9090b0;margin:4px 0 0 0;font-size:13px">${date}</p>
          </div>
        </div>

        <p style="color:#9090b0;line-height:1.6;margin-bottom:28px">
          Si c'était bien vous, confirmez cet appareil pour ne plus recevoir ces alertes.
          <br/>Si ce n'était <strong style="color:#f87171">pas vous</strong>, sécurisez immédiatement votre compte.
        </p>

        <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:28px">
          <a href="${trustLink}"
             style="display:block;background:#7c3aed;color:#fff;padding:16px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;text-align:center">
            C'était moi — Confirmer l'appareil
          </a>
          <a href="${rejectLink}"
             style="display:block;background:#1a1a2e;color:#f87171;padding:16px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;text-align:center;border:1px solid #7f1d1d">
            Ce n'était pas moi — Sécuriser mon compte
          </a>
        </div>

        <div style="background:#0f1a0f;border:1px solid #1a3a1a;border-radius:8px;padding:16px;margin-bottom:24px">
          <p style="color:#6ee7b7;margin:0;font-size:13px;line-height:1.5">
            <strong>Important :</strong> Ces liens expirent dans 24h.
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

// ─────────────────────────────────────────────
// Mise en page commune des e-mails des Réglages (couleurs Violet & or)
// ─────────────────────────────────────────────
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function emailLayout({ title, paragraphs = [], ctaLabel, ctaUrl, footer }) {
  const body = paragraphs.map(p => `<p style="color:#b8b2c8;line-height:1.6;margin:0 0 14px">${p}</p>`).join('')
  const cta = ctaUrl
    ? `<div style="text-align:center;margin:28px 0"><a href="${ctaUrl}" style="display:inline-block;background:#7c3aed;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">${escapeHtml(ctaLabel)}</a></div>`
    : ''
  return `
    <div style="font-family:Arial,sans-serif;background:#0b0a10;color:#f5f2fb;padding:40px;border-radius:12px;max-width:560px;margin:0 auto">
      <div style="text-align:center;margin-bottom:28px">
        <span style="display:inline-block;background:#7c3aed;border-radius:10px;padding:10px 18px;font-weight:900;font-size:16px;letter-spacing:2px;color:#fff">LS Bookers</span>
      </div>
      <h2 style="color:#ffffff;margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h2>
      ${body}${cta}
      <hr style="border:none;border-top:1px solid #24212f;margin:24px 0"/>
      <p style="color:#6b6680;font-size:11px;text-align:center;line-height:1.6">
        ${footer || 'Vous recevez cet e-mail car vous avez un compte LS Bookers.'}<br/>
        <a href="${APP_URL}/settings/notifications" style="color:#c4b5fd">Choisir mes e-mails</a> · © ${new Date().getFullYear()} LS Bookers
      </p>
    </div>`
}

/** Alerte : un nouvel appareil s'est connecté au compte */
async function sendLoginAlertEmail(to, { deviceName, date }) {
  await deliverEmail({
    from: FROM, to,
    subject: 'Nouvelle connexion à votre compte — LS Bookers',
    html: emailLayout({
      title: 'Nouvelle connexion à votre compte',
      paragraphs: [
        `Un appareil s'est connecté à votre compte : <strong style="color:#fff">${escapeHtml(deviceName)}</strong>, le ${escapeHtml(date)}.`,
        `Si c'était vous, il n'y a rien à faire.`,
        `Si ce n'était <strong style="color:#f87171">pas vous</strong>, retirez cet appareil et changez votre mot de passe depuis vos Réglages.`,
      ],
      ctaLabel: 'Voir mes appareils',
      ctaUrl: `${APP_URL}/settings/security`,
      footer: 'Alerte de sécurité : elle se désactive dans Réglages › Connexion et sécurité.',
    }),
  })
}

/** Confirmation d'une nouvelle adresse e-mail (envoyé à la nouvelle adresse) */
async function sendEmailChangeConfirmation(to, token) {
  await deliverEmail({
    from: FROM, to,
    subject: 'Confirmez votre nouvelle adresse e-mail — LS Bookers',
    html: emailLayout({
      title: 'Confirmez votre nouvelle adresse e-mail',
      paragraphs: [
        'Vous avez demandé à utiliser cette adresse pour votre compte LS Bookers.',
        'Cliquez sur le bouton ci-dessous pour confirmer (lien valable 24 h). Tant que vous ne confirmez pas, votre ancienne adresse reste active.',
        "Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.",
      ],
      ctaLabel: 'Confirmer cette adresse',
      ctaUrl: `${APP_URL}/confirm-email-change?token=${encodeURIComponent(token)}`,
      footer: 'E-mail de sécurité lié à votre compte.',
    }),
  })
}

/** Information envoyée à l'ancienne adresse une fois le changement confirmé */
async function sendEmailChangedNotice(to, newEmail) {
  await deliverEmail({
    from: FROM, to,
    subject: 'Votre adresse e-mail a été modifiée — LS Bookers',
    html: emailLayout({
      title: 'Votre adresse e-mail a été modifiée',
      paragraphs: [
        `Votre compte LS Bookers utilise désormais l'adresse <strong style="color:#fff">${escapeHtml(newEmail)}</strong>.`,
        "Si vous n'êtes pas à l'origine de ce changement, contactez-nous immédiatement en répondant à cet e-mail ou depuis la page Contact.",
      ],
      ctaLabel: 'Nous contacter',
      ctaUrl: `${APP_URL}/contact`,
      footer: 'E-mail de sécurité lié à votre compte.',
    }),
  })
}

/** E-mail d'une notification (booking, offre, avis, événement…) choisie dans les Réglages */
async function sendNotificationEmail(to, { content }) {
  await deliverEmail({
    from: FROM, to,
    subject: `${String(content).slice(0, 90)} — LS Bookers`,
    html: emailLayout({
      title: 'Du nouveau sur LS Bookers',
      paragraphs: [escapeHtml(content)],
      ctaLabel: 'Voir sur LS Bookers',
      ctaUrl: `${APP_URL}/notifications`,
    }),
  })
}

/** Nouveau message reçu pendant que le membre n'est pas sur le site */
async function sendNewMessageEmail(to, { senderName, conversationId }) {
  await deliverEmail({
    from: FROM, to,
    subject: `Nouveau message de ${String(senderName).slice(0, 60)} — LS Bookers`,
    html: emailLayout({
      title: `${escapeHtml(senderName)} vous a écrit`,
      paragraphs: ['Vous avez un nouveau message sur LS Bookers.'],
      ctaLabel: 'Lire le message',
      ctaUrl: `${APP_URL}/messages?c=${Number(conversationId)}`,
    }),
  })
}

module.exports = {
  deliverEmail, FROM, APP_URL, sendVerificationEmail, sendPasswordResetEmail, sendNewDeviceEmail,
  emailLayout, sendLoginAlertEmail, sendEmailChangeConfirmation, sendEmailChangedNotice,
  sendNotificationEmail, sendNewMessageEmail,
};
