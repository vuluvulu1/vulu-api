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
        await sendToUsers(await adminNames(), {
            notification: { title: 'Yeni kayıt isteği', body: `${reg.username} katılmak istiyor.` },
            data: { kind: 'registration', id, username: reg.username },
            android: { priority: 'high', notification: { channel_id: 'registrations', tag: `registration-${id}` } },
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

module.exports = { registrationPending, registrationResolved };
