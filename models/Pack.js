const mongoose = require('mongoose');

// vulu Packs: adminin launcher'dan paylaştığı instance'lar.
// CurseForge ve Modrinth modları sürümü sabitlenmiş indirme adresiyle listelenir; seçilen klasörlerin zip'i
// ve kapak resmi GridFS'in "packfiles" deposunda durur.
const modSchema = new mongoose.Schema({
    source: { type: String, enum: ['modrinth', 'curseforge'], default: 'modrinth' },
    projectId: String,
    versionId: String,
    title: String,
    versionNumber: String,
    type: { type: String, default: 'mod' },
    file: String,      // instance klasörüne göre yol, örn. "mods/sodium.jar"
    iconUrl: String,
    url: String,
    sha1: String,
    sha512: String,
    size: Number,
}, { _id: false });

// Bir revizyonda neyin değiştiği: mod listesi farkı sunucuda hesaplanır, not admin'den gelir
const changeSchema = new mongoose.Schema({
    revision: Number,
    at: { type: Date, default: Date.now },
    by: String,
    note: { type: String, default: '', maxlength: 1000 },
    added: { type: [String], default: [] },
    removed: { type: [String], default: [] },
    updated: { type: [{ title: String, from: String, to: String, _id: false }], default: [] },
    filesChanged: { type: Boolean, default: false },
}, { _id: false });

const packSchema = new mongoose.Schema({
    name: { type: String, required: true, maxlength: 40 },
    description: { type: String, default: '', maxlength: 600 },
    author: { type: String, required: true },
    mcVersion: { type: String, required: true },
    loader: { type: String, required: true },
    loaderVersion: { type: String, default: null },
    recommendedRamGb: { type: Number, default: 8 },
    revision: { type: Number, default: 1 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    mods: { type: [modSchema], default: [] },
    includes: { type: [String], default: [] },
    overridesFileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    overridesSize: { type: Number, default: 0 },
    coverFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    coverExt: { type: String, default: null },
    // Ana ekranda paket adının yerine gösterilen logo (isteğe bağlı)
    logoFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    logoExt: { type: String, default: null },
    changelog: { type: [changeSchema], default: [] },
    // Paketi görebilecek roller; boşsa herkese açık (bkz. lib/access.js)
    roles: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Role' }], default: [] },
});

module.exports = mongoose.model('Pack', packSchema, 'packs');
