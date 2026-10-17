const mongoose = require('mongoose');

// Uçtan uca şifreli mesajlaşma: kullanıcının açık anahtarı ve gizli anahtarının şifreli yedeği.
// Yedek, launcher'da kullanıcının şifresinden türetilen anahtarla (PBKDF2) şifrelenir; sunucu gizli anahtarı göremez.
const messageKeySchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    publicKey: { type: String, required: true },      // ECDH P-256, SubjectPublicKeyInfo (base64)
    keyId: { type: String, required: true },          // açık anahtarın SHA-256'sının ilk 16 karakteri
    backup: {
        cipher: { type: String, required: true },     // AES-256-GCM: şifreli PKCS#8 + etiket (base64)
        nonce: { type: String, required: true },
        salt: { type: String, required: true },
        iterations: { type: Number, required: true },
    },
    updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('MessageKey', messageKeySchema);
