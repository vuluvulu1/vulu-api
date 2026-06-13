const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    allowedPacks: { type: [String], default: ['Vanilla'] }, // hangi sürümlere erişebilir
    isActive: { type: Boolean, default: true },
    isAdmin: { type: Boolean, default: false }
});

module.exports = mongoose.model('User', userSchema);
