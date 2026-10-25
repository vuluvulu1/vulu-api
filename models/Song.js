const mongoose = require('mongoose');

// vulu Radyo şarkısı. Ses dosyası veritabanında değil sunucunun diskinde durur (RADIO_DIR/<_id>); veritabanı
// (Atlas, 512 MB) yalnızca bilgileri tutar. Yalnızca adminler yükler.
const songSchema = new mongoose.Schema({
    title: { type: String, required: true, maxlength: 100 },
    artist: { type: String, default: '', maxlength: 100 },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    uploadedBy: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('Song', songSchema, 'songs');
