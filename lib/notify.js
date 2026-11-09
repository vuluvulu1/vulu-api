// Adminlere giden push bildirimleri. Alıcılar her gönderimde veritabanından seçilir: adminliği alınan ya da hesabı
// kapatılan biri hemen bildirim almayı bırakır. Bildirimde e-posta adresi yoktur (içerik Google'ın sunucularından
// geçer); kullanıcı adı ve istek kimliği yeter, ayrıntıyı uygulama API'den alır.
const User = require('../models/User');
const { sendToUsers } = require('./push');

async function adminNames(except) {
    const admins = await User.find({ isAdmin: true, isActive: true, notifyRegistrations: { $ne: false } }).select('username').lean();
    return admins.map(a => a.username).filter(name => name !== except);
}

/** Onay bekleyen yeni kayıt isteği: bütün adminlere. Uygulama aynı isteğin bildirimini tag ile tekilleştirir. */
async function registrationPending(reg) {
    try {
        const id = String(reg._id);
        // Yalnızca veri: bildirimi uygulama kendisi gösterir, böylece üstüne Onayla/Reddet düğmeleri konabilir
        await sendToUsers(await adminNames(), {
            data: { kind: 'registration', id, username: reg.username, title: 'Yeni kayıt isteği', body: `${reg.username} katılmak istiyor.` },
            android: { priority: 'high' },
        });
    } catch (err) { console.error('Kayıt bildirimi gönderilemedi:', err.message); }
}

/** Bir admin onayladı ya da reddetti: öbür adminlerin telefonundaki bildirim kalkar (sessiz, yalnızca veri). */
async function registrationResolved(id, username, action, by) {
    try {
        await sendToUsers(await adminNames(by), {
            data: { kind: 'registration.resolved', id: String(id), username, action, by },
            android: { priority: 'high' },
        });
    } catch (err) { console.error('Kayıt bildirimi gönderilemedi:', err.message); }
}

// ── vulu Sosyal: mesaj, arkadaşlık ve ekran görüntüsü bildirimleri ─────────────────────────────────────────
// Alıcının tercihi (notifyMessages/Friends/Shots) ve hesabının açık olması gönderim anında denetlenir.
async function wants(username, field) {
    return !!(await User.exists({ username, isActive: { $ne: false }, [field]: { $ne: false } }));
}

// Aynı kişiden art arda gelen mesajlar Google'a tek tek gitmesin: kişi çifti başına 10 saniyede bir push.
// Telefon bildirimi tag ile tekilleştirir; uygulama açılınca yazışma zaten güncel gelir.
const lastMessagePush = new Map();
const MESSAGE_PUSH_GAP = 10 * 1000;

/** Yeni şifreli mesaj. İçerik yoktur (sunucu da okuyamaz): yalnızca kimden geldiği. */
async function messageReceived(to, from) {
    try {
        const key = from + '>' + to, now = Date.now();
        if (now - (lastMessagePush.get(key) || 0) < MESSAGE_PUSH_GAP) return;
        lastMessagePush.set(key, now);
        if (lastMessagePush.size > 5000) for (const [k, t] of lastMessagePush) if (now - t > MESSAGE_PUSH_GAP) lastMessagePush.delete(k);
        if (!await wants(to, 'notifyMessages')) return;
        await sendToUsers([to], {
            notification: { title: from, body: 'Yeni şifreli mesaj' },
            data: { kind: 'message', id: from, username: from },
            android: { priority: 'high', notification: { channel_id: 'messages', tag: 'message-' + from } },
        });
    } catch (err) { console.error('Mesaj bildirimi gönderilemedi:', err.message); }
}

/** Mesajlar okundu: kişinin öbür telefonlarındaki bildirim kalkar (sessiz). */
async function messagesRead(reader, peer) {
    try {
        await sendToUsers([reader], { data: { kind: 'message.read', id: peer, username: peer }, android: { priority: 'normal' } });
    } catch (err) { console.error('Okundu bildirimi gönderilemedi:', err.message); }
}

/** Arkadaşlık isteği geldi ya da kabul edildi. */
async function friendEvent(to, from, accepted) {
    try {
        if (!await wants(to, 'notifyFriends')) return;
        await sendToUsers([to], {
            notification: accepted
                ? { title: 'Arkadaşlık isteği kabul edildi', body: from + ' artık arkadaşın.' }
                : { title: 'Arkadaşlık isteği', body: from + ' seni arkadaş olarak eklemek istiyor.' },
            data: { kind: accepted ? 'friend.accepted' : 'friend.request', id: from, username: from },
            android: { priority: 'high', notification: { channel_id: 'social', tag: 'friend-' + from } },
        });
    } catch (err) { console.error('Arkadaşlık bildirimi gönderilemedi:', err.message); }
}

/** Ekran görüntüsüne beğeni ya da yorum. Yorum metni uygulamada zaten herkese açık; ilk 100 karakteri gösterilir. */
async function shotEvent(to, from, shotId, kind, text) {
    try {
        if (!await wants(to, 'notifyShots')) return;
        const body = kind === 'comment' ? from + ': ' + String(text || '').slice(0, 100) : from + ' ekran görüntünü beğendi.';
        await sendToUsers([to], {
            notification: { title: kind === 'comment' ? 'Yeni yorum' : 'Yeni beğeni', body },
            data: { kind: 'shot', id: String(shotId), username: from },
            android: { priority: 'normal', notification: { channel_id: 'social', tag: 'shot-' + shotId + '-' + kind } },
        });
    } catch (err) { console.error('Ekran görüntüsü bildirimi gönderilemedi:', err.message); }
}

module.exports = { registrationPending, registrationResolved, messageReceived, messagesRead, friendEvent, shotEvent };
