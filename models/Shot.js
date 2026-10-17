const mongoose = require('mongoose');

// Paylaşılan ekran görüntüsü. Resim ve küçük önizleme GridFS'te ("shots" kovası) durur.
const shotSchema = new mongoose.Schema({
    author: { type: String, required: true, index: true },
    caption: { type: String, default: '', maxlength: 200 },
    // Hangi paketten (vulu pack ya da kişisel instance adı); yalnızca bilgi amaçlı
    packName: { type: String, default: '', maxlength: 64 },
    packId: { type: String, default: null },
    mcVersion: { type: String, default: '', maxlength: 32 },
    imageFileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    thumbFileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    imageType: { type: String, required: true },
    thumbType: { type: String, default: null },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    size: { type: Number, default: 0 },          // resim + önizleme bayt
    likes: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('Shot', shotSchema, 'shots');
