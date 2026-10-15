const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Avatar = require('../models/Avatar');
const Pack = require('../models/Pack');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_BIO = 300;

// Şifre hash'i ve izinler asla dışarı verilmez
function publicProfile(user, packCount = 0) {
    return {
        username: user.username,
        bio: user.bio || '',
        isAdmin: !!user.isAdmin,
        avatarVersion: user.avatarVersion || 0,
        createdAt: user.createdAt || null,
        lastSeenAt: user.lastSeenAt || null,
        packCount,
    };
}

async function packCounts() {
    const rows = await Pack.aggregate([{ $group: { _id: '$author', count: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map(r => [r._id, r.count]));
}

// GET /users — bütün aktif kullanıcılar
router.get('/', requireAuth, async (req, res) => {
    const [users, counts] = await Promise.all([
        User.find({ isActive: true }).sort({ lastSeenAt: -1, username: 1 }),
        packCounts(),
    ]);
    res.json(users.map(u => publicProfile(u, counts[u.username] || 0)));
});

// GET /users/me
router.get('/me', requireAuth, async (req, res) => {
    const counts = await packCounts();
    res.json(publicProfile(req.user, counts[req.user.username] || 0));
});

// PUT /users/me — açıklama
router.put('/me', requireAuth, async (req, res) => {
    const bio = String(req.body.bio ?? '').trim();
    if (bio.length > MAX_BIO) return res.status(400).json({ error: `Açıklama en fazla ${MAX_BIO} karakter olabilir.` });

    req.user.bio = bio;
    await req.user.save();
    res.json(publicProfile(req.user));
});

// PUT /users/me/avatar — gövde resmin kendisi (Content-Type: image/png vb.)
router.put('/me/avatar', requireAuth, express.raw({ type: AVATAR_TYPES, limit: '1mb' }), async (req, res) => {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!AVATAR_TYPES.includes(contentType) || !Buffer.isBuffer(req.body) || req.body.length === 0)
        return res.status(400).json({ error: 'Desteklenen biçimler: PNG, JPG, WEBP, GIF (en fazla 1 MB).' });

    await Avatar.findOneAndUpdate(
        { username: req.user.username },
        { data: req.body, contentType, updatedAt: new Date() },
        { upsert: true });

    req.user.avatarVersion = Date.now();
    await req.user.save();
    res.json(publicProfile(req.user));
});

// DELETE /users/me/avatar
router.delete('/me/avatar', requireAuth, async (req, res) => {
    await Avatar.deleteOne({ username: req.user.username });
    req.user.avatarVersion = 0;
    await req.user.save();
    res.json(publicProfile(req.user));
});

// POST /users/me/password
router.post('/me/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
        return res.status(400).json({ error: 'Mevcut ve yeni şifre gerekli.' });
    if (String(newPassword).length < 6 || String(newPassword).length > 72)
        return res.status(400).json({ error: 'Yeni şifre 6-72 karakter olmalı.' });

    const valid = await bcrypt.compare(String(currentPassword), req.user.passwordHash);
    if (!valid) return res.status(400).json({ error: 'Mevcut şifre yanlış.' });

    req.user.passwordHash = await bcrypt.hash(String(newPassword), 10);
    await req.user.save();
    res.json({ success: true });
});

// GET /users/:username — profil ve paylaştığı paketler
router.get('/:username', requireAuth, async (req, res) => {
    const user = await User.findOne({ username: req.params.username, isActive: true });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

    const packs = await Pack.find({ author: user.username }).sort({ updatedAt: -1 })
        .select('name revision updatedAt mcVersion loader coverFileId').lean();

    res.json({
        ...publicProfile(user, packs.length),
        packs: packs.map(p => ({
            id: String(p._id), name: p.name, revision: p.revision, updatedAt: p.updatedAt,
            mcVersion: p.mcVersion, loader: p.loader, hasCover: !!p.coverFileId,
        })),
    });
});

// GET /users/:username/avatar — <img> doğrudan yüklesin diye herkese açık; adres ?v=avatarVersion ile değişir
router.get('/:username/avatar', async (req, res) => {
    const avatar = await Avatar.findOne({ username: req.params.username });
    if (!avatar) return res.status(404).end();
    res.set('Content-Type', avatar.contentType);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(avatar.data);
});

module.exports = router;
