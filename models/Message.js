const mongoose = require('mongoose');

// Şifreli direkt mesaj. Sunucu yalnızca kimin kime ne zaman yazdığını ve şifreli içeriği görür.
const messageSchema = new mongoose.Schema({
    from: { type: String, required: true },
    to: { type: String, required: true },
    // İki tarafın kimlik anahtarları arasındaki ECDH sırrından türetilen anahtarla AES-256-GCM
    cipher: { type: String, required: true },         // şifreli metin + etiket (base64)
    nonce: { type: String, required: true },
    salt: { type: String, required: true },           // HKDF tuzu (mesaj başına)
    senderKeyId: { type: String, required: true },
    recipientKeyId: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 365 * 24 * 60 * 60 },   // bir yıl sonra silinir
    readAt: { type: Date, default: null },
});
messageSchema.index({ to: 1, createdAt: 1 });
messageSchema.index({ from: 1, to: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
