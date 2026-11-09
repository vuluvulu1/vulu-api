const mongoose = require('mongoose');

// Push bildirimi alan telefon (vulu Sosyal). token: Firebase Cloud Messaging kayıt token'ı. Aynı telefonda başka
// bir hesapla giriş yapılırsa kayıt o hesaba geçer (token tekildir). FCM token'ı artık geçersiz derse kayıt silinir;
// hesabın şifresi değişir, hesap kapatılır ya da silinirse o hesabın bütün cihazları silinir.
const deviceSchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ['android'], default: 'android' },
    createdAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Device', deviceSchema);
