const mongoose = require('mongoose');

// vulu Radyo şarkısı. Ses dosyası GridFS'te ("songfiles" kovası) durur; yalnızca adminler yükler.
const songSchema = new mongoose.Schema({
    title: { type: String, required: true, maxlength: 100 },
    artist: { type: String, default: '', maxlength: 100 },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    uploadedBy: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('Song', songSchema, 'songs');
