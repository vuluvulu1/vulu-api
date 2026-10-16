const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    email: { type: String, default: '' }, // kayıt ekranından gelenlerde dolu; eski hesaplarda boş
    isActive: { type: Boolean, default: true },
    isAdmin: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 }, // şifre değişince artar; eski oturumlar kapanır

    // Profil
    bio: { type: String, default: '', maxlength: 300 },
    avatarVersion: { type: Number, default: 0 }, // 0 = avatar yok; değişince launcher önbelleği yenilenir
    lastSeenAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
