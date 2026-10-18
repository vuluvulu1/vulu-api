const mongoose = require('mongoose');

// Admin'in launcher ana ekranına koyduğu duyuru. Aynı anda en yenisi gösterilir.
const announcementSchema = new mongoose.Schema({
    text: { type: String, required: true, maxlength: 500 },
    author: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },   // null = kaldırılana kadar
});

module.exports = mongoose.model('Announcement', announcementSchema, 'announcements');
