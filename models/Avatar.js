const mongoose = require('mongoose');

// Profil resimleri ayrı koleksiyonda durur; kullanıcı listesi çekilirken resimler taşınmaz.
const avatarSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    data: { type: Buffer, required: true },
    contentType: { type: String, required: true },
    updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Avatar', avatarSchema, 'avatars');
