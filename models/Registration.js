const mongoose = require('mongoose');

// Launcher'dan ya da siteden gelen katılma isteği. Bir admin onaylayınca gerçek kullanıcı (User) oluşturulur ve
// istek silinir; reddedilirse yalnızca istek silinir. Şifre burada da yalnızca hash olarak durur.
//
// E-posta doğrulaması: istek önce emailVerified: false ile oluşur ve adrese bir bağlantı gider. Bağlantı açılınca
// emailVerified true olur; admin yalnızca doğrulanmış istekleri onaylayabilir. Doğrulanmayan istek 48 saat sonra
// MongoDB tarafından kendiliğinden silinir (expireAt; doğrulanınca alan kaldırılır, istek kalıcı olur).
// Bu sistemden önce oluşan isteklerde emailVerified alanı yoktur ve doğrulanmış sayılır.
const registrationSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    passwordHash: { type: String, required: true },
    ip: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    emailVerified: { type: Boolean },
    verifyTokenHash: { type: String, index: true },
    verifySentAt: { type: Date },
    expireAt: { type: Date, expires: 0 },
});

module.exports = mongoose.model('Registration', registrationSchema);
