const mongoose = require('mongoose');

// vulu Server Panel'in hesaba bağlanması: yalnızca vulu Packs'i okuyabilen uzun ömürlü token.
// Token'ın kendisi değil SHA-256'sı saklanır. Kullanıcının şifresi değişince (tokenVersion artınca) geçersiz olur;
// 365 gün sonra kendiliğinden silinir.
const panelTokenSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true },
    username: { type: String, required: true, index: true },
    tokenVersion: { type: Number, default: 0 },
    label: { type: String, default: '', maxlength: 60 },
    lastUsedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now, expires: 365 * 24 * 60 * 60 },
});

module.exports = mongoose.model('PanelToken', panelTokenSchema);
