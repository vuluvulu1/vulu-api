const mongoose = require('mongoose');

// Geri bildirimler. area 'packs': vulu Packs (pack boşsa pakete bağlı olmayan istek, ör. "şu modpack'i de ekleyin");
// area 'launcher': launcher'ın kendisi hakkında hata bildirimi ve öneriler. Admin "yapıldı" diye işaretleyip yanıt yazar.
const feedbackSchema = new mongoose.Schema({
    area: { type: String, enum: ['packs', 'launcher'], default: 'packs', index: true },
    pack: { type: mongoose.Schema.Types.ObjectId, ref: 'Pack', default: null, index: true },
    kind: { type: String, enum: ['feedback', 'request', 'bug', 'idea'], default: 'feedback' },
    // Launcher geri bildiriminde yazıldığı sürüm ve platform (hatayı tekrarlamak için; yalnızca adminler görür)
    meta: { type: { version: String, platform: String, _id: false }, default: undefined },
    text: { type: String, required: true, maxlength: 1000 },
    author: { type: String, required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    status: { type: String, enum: ['open', 'done'], default: 'open' },
    reply: { type: String, default: '', maxlength: 500 },
    repliedBy: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Feedback', feedbackSchema);
