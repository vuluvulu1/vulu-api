const mongoose = require('mongoose');

// Profil bannerları ayrı koleksiyonda durur; kullanıcı listesi çekilirken resimler taşınmaz.
const bannerSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    data: { type: Buffer, required: true },
    contentType: { type: String, required: true },
    updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Banner', bannerSchema, 'banners');
