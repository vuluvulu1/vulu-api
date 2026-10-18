const mongoose = require('mongoose');

// Birinin ekran görüntüne beğeni ya da yorum bırakması; launcher bunları yoklayıp bildirim gösterir.
const shotEventSchema = new mongoose.Schema({
    to: { type: String, required: true },
    from: { type: String, required: true },
    shot: { type: mongoose.Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ['like', 'comment'], required: true },
    text: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});
shotEventSchema.index({ to: 1, createdAt: 1 });

module.exports = mongoose.model('ShotEvent', shotEventSchema, 'shotevents');
