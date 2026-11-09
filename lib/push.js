// Push bildirimleri: Firebase Cloud Messaging HTTP v1. Kimlik bilgisi bir Google servis hesabıdır:
//   FCM_SERVICE_ACCOUNT       servis hesabı JSON'unun kendisi (tek satır), ya da
//   FCM_SERVICE_ACCOUNT_FILE  o JSON dosyasının yolu
// İkisi de yoksa pushEnabled() false döner ve hiçbir şey gönderilmez (API normal çalışmaya devam eder).
//
// Gönderim hiçbir zaman isteği bekletmez ya da hata fırlatmaz: çağıran "ateşle ve unut" kullanır, sorunlar loglanır.
const fs = require('fs');
const jwt = require('jsonwebtoken');
const Device = require('../models/Device');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let account;           // ayrıştırılmış servis hesabı (null: yok ya da bozuk)
let accessToken = null, accessTokenExpires = 0;
let accessTokenRequest = null;   // aynı anda birden fazla gönderim tek token isteğini paylaşır

function serviceAccount() {
    if (account !== undefined) return account;
    try {
        const raw = process.env.FCM_SERVICE_ACCOUNT
            || (process.env.FCM_SERVICE_ACCOUNT_FILE && fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8'));
        const parsed = raw ? JSON.parse(raw) : null;
        account = parsed && parsed.client_email && parsed.private_key && parsed.project_id ? parsed : null;
        if (raw && !account) console.error('Push: servis hesabı JSON\'unda client_email, private_key ya da project_id yok.');
    } catch (err) {
        console.error('Push: servis hesabı okunamadı:', err.message);
        account = null;
    }
    return account;
}

const pushEnabled = () => !!serviceAccount();

/** Google'dan bir saatlik erişim token'ı (servis hesabının imzalı JWT'siyle); süresi dolana kadar saklanır. */
async function getAccessToken() {
    if (accessToken && Date.now() < accessTokenExpires - 60_000) return accessToken;
    accessTokenRequest ??= requestAccessToken().finally(() => { accessTokenRequest = null; });
    return accessTokenRequest;
}

async function requestAccessToken() {
    const sa = serviceAccount();
    const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 },
        sa.private_key, { algorithm: 'RS256' });
    const res = await fetch(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
        signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(`Google erişim token'ı alınamadı (${res.status}): ${body.error_description || body.error || ''}`);
    accessToken = body.access_token;
    accessTokenExpires = Date.now() + (body.expires_in || 3600) * 1000;
    return accessToken;
}

/** Tek bir cihaza gönderir. Token artık geçersizse (uygulama silinmiş vb.) cihaz kaydı silinir. */
async function sendToToken(token, message) {
    const sa = serviceAccount();
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { ...message, token } }),
        signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return;
    const body = await res.json().catch(() => ({}));
    const code = (body.error?.details || []).map(d => d.errorCode).find(Boolean) || body.error?.status || '';
    if (code === 'UNREGISTERED' || (res.status === 400 && code === 'INVALID_ARGUMENT' && /token/i.test(body.error?.message || ''))) {
        await Device.deleteOne({ token });
        return;
    }
    if (res.status === 401) accessToken = null;   // bir sonraki gönderimde yeni token alınır
    throw new Error(`FCM ${res.status} ${code}: ${body.error?.message || ''}`.trim());
}

/**
 * Kullanıcıların bütün cihazlarına gönderir. FCM'deki değerler metin olmalı; data alanları burada metne çevrilir.
 * Beklemek zorunlu değildir: hatalar loglanır, fırlatılmaz.
 */
async function sendToUsers(usernames, message) {
    if (!pushEnabled() || !usernames.length) return;
    try {
        const devices = await Device.find({ username: { $in: usernames } }).select('token').lean();
        if (!devices.length) return;
        const data = message.data ? Object.fromEntries(Object.entries(message.data).map(([k, v]) => [k, String(v ?? '')])) : undefined;
        const results = await Promise.allSettled(devices.map(d => sendToToken(d.token, { ...message, data })));
        for (const r of results) if (r.status === 'rejected') console.error('Push gönderilemedi:', r.reason?.message || r.reason);
    } catch (err) {
        console.error('Push gönderilemedi:', err.message);
    }
}

module.exports = { pushEnabled, sendToUsers };
