const mongoose = require('mongoose');

// vulu Packs geri bildirimleri ve istekleri. pack boşsa belirli bir pakete değil genele yazılmıştır
// (ör. "şu modpack'i de ekleyin"). Admin "yapıldı" olarak işaretleyip kısa bir yanıt yazabilir.
const feedbackSchema = new mongoose.Schema({
    pack: { type: mongoose.Schema.Types.ObjectId, ref: 'Pack', default: null, index: true },
    kind: { type: String, enum: ['feedback', 'request'], default: 'feedback' },
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
