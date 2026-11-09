const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    email: { type: String, default: '' }, // kayıt ekranından gelenlerde dolu; eski hesaplarda boş
    // E-posta değişikliği: yeni adres, postadaki bağlantı açılana kadar burada bekler (token'ın SHA-256'sı saklanır)
    // Bağlı Microsoft hesabının Minecraft profili: sahiplik sunucuda Minecraft servislerine sorularak doğrulanır
    minecraft: {
        uuid: { type: String, index: true },
        name: { type: String },
        verifiedAt: { type: Date },
    },
    pendingEmail: { type: String },
    emailTokenHash: { type: String },
    emailTokenExpires: { type: Date },
    isActive: { type: Boolean, default: true },
    isAdmin: { type: Boolean, default: false },
    roles: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Role' }], default: [] },
    tokenVersion: { type: Number, default: 0 }, // şifre değişince artar; eski oturumlar kapanır
    // Adminler için: yeni kayıt isteği telefona push bildirimi olarak gelsin mi (vulu Sosyal)
    notifyRegistrations: { type: Boolean, default: true },
    // vulu Sosyal telefon bildirimleri: mesaj, arkadaşlık istekleri, ekran görüntüsüne beğeni/yorum
    notifyMessages: { type: Boolean, default: true },
    notifyFriends: { type: Boolean, default: true },
    notifyShots: { type: Boolean, default: true },

    // Profil
    bio: { type: String, default: '', maxlength: 300 },
    avatarVersion: { type: Number, default: 0 }, // 0 = avatar yok; değişince launcher önbelleği yenilenir
    bannerVersion: { type: Number, default: 0 }, // 0 = banner yok
    // Profilde gösterilen oynama istatistiği (launcher gönderir; kullanıcı kapatırsa silinir)
    playtime: {
        type: {
            totalSeconds: Number,
            top: [{ name: String, seconds: Number, _id: false }],
            updatedAt: Date,
        },
        default: undefined,
    },
    skinHash: { type: String, default: '' },      // boş = varsayılan skin (Steve/Alex)
    skinModel: { type: String, enum: ['default', 'slim'], default: 'default' },
    lastSeenAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
