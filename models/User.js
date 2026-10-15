const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    allowedPacks: { type: [String], default: ['Vanilla'] }, // hangi sürümlere erişebilir
    isActive: { type: Boolean, default: true },
    isAdmin: { type: Boolean, default: false },

    // Profil
    bio: { type: String, default: '', maxlength: 300 },
    avatarVersion: { type: Number, default: 0 }, // 0 = avatar yok; değişince launcher önbelleği yenilenir
    lastSeenAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
