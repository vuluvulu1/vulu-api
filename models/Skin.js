const mongoose = require('mongoose');

// Oyuncu skinleri. Resim içeriğinin SHA-256'sıyla anılır; oyun /yggdrasil/textures/<hash> adresinden indirir.
// Kullanıcının hangi skini kullandığı User.skinHash / skinModel alanlarında durur.
const skinSchema = new mongoose.Schema({
    hash: { type: String, required: true, unique: true },
    data: { type: Buffer, required: true },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Skin', skinSchema);
