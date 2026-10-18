const express = require('express');
const mongoose = require('mongoose');
const Announcement = require('../models/Announcement');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/** Launcher ana ekranındaki duyuru. Herkes okur, yalnızca admin yazar ve kaldırır. */
const router = express.Router();
router.use(requireAuth);

const MAX_HOURS = 24 * 60;

const toClient = a => a && ({ id: String(a._id), text: a.text, author: a.author, createdAt: a.createdAt, expiresAt: a.expiresAt });

const current = () => Announcement.findOne({ $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).sort({ createdAt: -1 }).lean();

// GET /announcements — şu anki duyuru (yoksa null)
router.get('/', async (req, res) => {
    res.json({ announcement: toClient(await current()) });
});

// POST /announcements { text, hours? } (admin) — öncekinin yerine geçer
router.post('/', requireAdmin, async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (text.length < 1 || text.length > 500) return res.status(400).json({ error: 'Duyuru 1-500 karakter olmalı.' });
    const hours = Number(req.body?.hours) || 0;
    if (hours < 0 || hours > MAX_HOURS) return res.status(400).json({ error: 'Süre en fazla 60 gün olabilir.' });
    await Announcement.deleteMany({});   // tek duyuru: eskiler birikmesin
    const a = await Announcement.create({
        text, author: req.user.username,
        expiresAt: hours > 0 ? new Date(Date.now() + hours * 3600 * 1000) : null,
    });
    res.status(201).json({ announcement: toClient(a.toObject()) });
});

// DELETE /announcements/:id (admin)
router.delete('/:id', requireAdmin, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Duyuru bulunamadı.' });
    const result = await Announcement.deleteOne({ _id: req.params.id });
    if (!result.deletedCount) return res.status(404).json({ error: 'Duyuru bulunamadı.' });
    res.json({ success: true });
});

module.exports = router;
