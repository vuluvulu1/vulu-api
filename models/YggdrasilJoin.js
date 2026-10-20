const mongoose = require('mongoose');

// Oyuncu bir sunucuya katılırken oyunun bıraktığı kayıt (join); sunucu birkaç saniye içinde hasJoined ile sorar.
// Veritabanında tutulur ki oyuncunun launcher'ı ile sunucunun konuştuğu API farklı kopyalar olsa da
// (ör. taşınma sırasında Render ve VDS) doğrulama çalışsın. 30 sn'den eskisi geçersizdir.
const joinSchema = new mongoose.Schema({
    _id: { type: String },                        // serverId
    username: { type: String, required: true },
    profileId: { type: String, required: true },
    ip: { type: String, default: '' },
    at: { type: Date, required: true, expires: 2 * 60 },
}, { versionKey: false });

module.exports = mongoose.model('YggdrasilJoin', joinSchema, 'yggdrasiljoins');
