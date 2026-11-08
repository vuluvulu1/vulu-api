const mongoose = require('mongoose');

// Adminlerin uygulamadan değiştirdiği genel ayarlar (anahtar → değer). Okuma lib/settings.js üzerinden yapılır.
const settingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed },
    updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Setting', settingSchema);
