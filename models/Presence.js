const mongoose = require('mongoose');

// Çevrimiçi durum (arkadaş listesi). Launcher 45 sn'de bir bildirir. Veritabanında tutulur ki aynı veritabanını
// kullanan birden fazla API (ör. taşınma sırasında Render ve VDS) aynı listeyi görsün. Belge, son bildirimden
// 2 dakika sonra okunmaz; MongoDB de onu kısa süre sonra kendisi siler.
const presenceSchema = new mongoose.Schema({
    _id: { type: String },                   // kullanıcı adı
    state: { type: String, required: true }, // launcher | playing | online
    instance: { type: String, default: '' },
    mcVersion: { type: String, default: '' },
    loader: { type: String, default: '' },
    packId: { type: String, default: null },
    server: { type: String, default: '' },
    since: { type: Date, required: true },   // bu duruma ne zaman geçildi
    at: { type: Date, required: true, expires: 5 * 60 },
}, { versionKey: false });

module.exports = mongoose.model('Presence', presenceSchema, 'presences');
