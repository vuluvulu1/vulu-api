const mongoose = require('mongoose');

// Launcher'dan gelen kayıt isteği. Bir admin onaylayınca gerçek kullanıcı (User) oluşturulur ve istek silinir;
// reddedilirse yalnızca istek silinir. Şifre burada da yalnızca hash olarak durur.
const registrationSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    passwordHash: { type: String, required: true },
    ip: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Registration', registrationSchema);
