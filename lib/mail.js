// E-posta gönderimi (Resend). RESEND_API_KEY yoksa e-posta gönderilmez ve mailEnabled() false döner;
// o zaman kayıt eski akışla çalışır (e-posta doğrulaması atlanır).

const FROM = () => process.env.MAIL_FROM || 'vulu <vulu@vuluvulu.com.tr>';
const SITE_URL = () => (process.env.SITE_URL || 'https://vuluvulu.com.tr').replace(/\/$/, '');

const mailEnabled = () => !!process.env.RESEND_API_KEY;

async function sendMail({ to, subject, html, text }) {
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM(), to: [to], subject, html, text }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`E-posta gönderilemedi (${res.status}): ${detail.slice(0, 200)}`);
    }
}

const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "E-posta adresini doğrula" postası. Bağlantı sitedeki /dogrula sayfasını açar. */
function verificationMail(username, token) {
    const link = `${SITE_URL()}/dogrula?token=${encodeURIComponent(token)}`;
    const subject = 'vulu: e-posta adresini doğrula';
    const text = [
        `Merhaba ${username},`,
        '',
        'vulu\'ya katılma isteğin bize ulaştı. İsteğinin bir admine gitmesi için e-posta adresini şu bağlantıdan doğrula:',
        link,
        '',
        'Bağlantı 48 saat geçerli. Bu isteği sen göndermediysen bu e-postayı görmezden gelebilirsin; doğrulanmayan istekler kendiliğinden silinir.',
        '',
        'vulu',
    ].join('\n');
    const html = `<!doctype html>
<html lang="tr"><body style="margin:0;background:#0d0b0a;font-family:Segoe UI,Arial,sans-serif;color:#ece6dd">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <p style="font-size:22px;font-weight:700;color:#e3b37a;margin:0 0 24px">vulu</p>
    <p style="font-size:16px;margin:0 0 12px">Merhaba <b>${escape(username)}</b>,</p>
    <p style="font-size:15px;line-height:1.6;color:#c9bfb4;margin:0 0 24px">
      vulu'ya katılma isteğin bize ulaştı. İsteğinin bir admine gitmesi için e-posta adresini doğrula.
    </p>
    <a href="${link}" style="display:inline-block;background:#c27e3e;color:#160e07;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:6px">
      E-posta adresimi doğrula
    </a>
    <p style="font-size:13px;line-height:1.6;color:#8a8077;margin:28px 0 0">
      Düğme çalışmazsa bu bağlantıyı tarayıcına yapıştır:<br>
      <a href="${link}" style="color:#e3b37a;word-break:break-all">${link}</a>
    </p>
    <p style="font-size:13px;line-height:1.6;color:#8a8077;margin:20px 0 0">
      Bağlantı 48 saat geçerli. Bu isteği sen göndermediysen bu e-postayı görmezden gelebilirsin; doğrulanmayan istekler kendiliğinden silinir.
    </p>
  </div>
</body></html>`;
    return { subject, html, text };
}

module.exports = { mailEnabled, sendMail, verificationMail };
