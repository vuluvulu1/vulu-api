const mongoose = require('mongoose');

// Oyun oturumu: launcher oyunu başlatırken alır, oyun bir sunucuya/LAN'a katılırken bununla kimliğini kanıtlar.
// Token'ın kendisi değil SHA-256'sı saklanır; 7 gün sonra kendiliğinden silinir.
const gameSessionSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    profileId: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 60 * 60 },
});

module.exports = mongoose.model('GameSession', gameSessionSchema);
