const mongoose = require('mongoose');

// Arkadaşlık: biri istek gönderir (pending), öteki kabul edince arkadaş olurlar (accepted).
// İki kullanıcı arasında tek kayıt olur: a ve b kullanıcı adlarıdır, a < b sıralı tutulur.
const friendshipSchema = new mongoose.Schema({
    a: { type: String, required: true },
    b: { type: String, required: true },
    from: { type: String, required: true },   // isteği gönderen
    status: { type: String, enum: ['pending', 'accepted'], default: 'pending' },
    createdAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date, default: null },
});
friendshipSchema.index({ a: 1, b: 1 }, { unique: true });
friendshipSchema.index({ b: 1 });

/** İki kullanıcı adının sıralı çifti (kayıt anahtarı). */
friendshipSchema.statics.pair = (x, y) => (x < y ? { a: x, b: y } : { a: y, b: x });

/** Kullanıcının kabul edilmiş arkadaşlarının adları. */
friendshipSchema.statics.friendsOf = async function (username) {
    const rows = await this.find({ status: 'accepted', $or: [{ a: username }, { b: username }] }).select('a b').lean();
    return rows.map(r => (r.a === username ? r.b : r.a));
};

module.exports = mongoose.model('Friendship', friendshipSchema);
