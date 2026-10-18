const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Avatar = require('../models/Avatar');
const Registration = require('../models/Registration');
const Skin = require('../models/Skin');
const GameSession = require('../models/GameSession');
const PanelToken = require('../models/PanelToken');
const Message = require('../models/Message');
const MessageKey = require('../models/MessageKey');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const toClient = r => ({ id: String(r._id), username: r.username, email: r.email, createdAt: r.createdAt });

// ── Kullanıcılar ──────────────────────────────────────────────────────
// Kullanıcı adı sonradan değiştirilemez: Minecraft oyuncu kimliğini (dünyalardaki eşyalar, ilerleme) addan
// türetir; paketler, avatarlar ve geri bildirimler de ada bağlıdır.
const USERNAME = /^[A-Za-z0-9_]{3,16}$/;
const sameName = name => new RegExp(`^${name}$`, 'i'); // ad yalnızca harf/rakam/_ içerdiği için güvenli

const userToClient = u => ({
    id: String(u._id),
    username: u.username,
    email: u.email || '',
    isAdmin: !!u.isAdmin,
    isActive: u.isActive !== false,
    createdAt: u.createdAt || null,
    lastSeenAt: u.lastSeenAt || null,
});

function validPassword(password) {
    return typeof password === 'string' && password.length >= 6 && Buffer.byteLength(password) <= 72;
}

/** Bu değişiklikten sonra en az bir aktif admin kalıyor mu? */
async function otherActiveAdminExists(exceptId) {
    return !!(await User.exists({ _id: { $ne: exceptId }, isAdmin: true, isActive: { $ne: false } }));
}

// GET /admin/users
router.get('/users', async (req, res) => {
    const users = await User.find().sort({ isAdmin: -1, username: 1 }).lean();
    res.json(users.map(userToClient));
});

// POST /admin/users { username, password, email?, isAdmin, isActive }
router.post('/users', async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!USERNAME.test(username))
        return res.status(400).json({ error: 'Kullanıcı adı 3-16 karakter olmalı; yalnızca İngilizce harf, rakam ve _ kullanılabilir.' });
    if (!validPassword(req.body.password))
        return res.status(400).json({ error: 'Şifre 6-72 karakter olmalı.' });
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
        return res.status(400).json({ error: 'E-posta adresi geçersiz.' });
    if (await User.exists({ username: sameName(username) }) || await Registration.exists({ username: sameName(username) }))
        return res.status(409).json({ error: 'Bu kullanıcı adı alınmış ya da bekleyen bir kayıt isteğinde.' });

    const user = await User.create({
        username, email,
        passwordHash: await bcrypt.hash(req.body.password, 10),
        isAdmin: req.body.isAdmin === true,
        isActive: req.body.isActive !== false,
    });
    res.status(201).json(userToClient(user));
});

// PATCH /admin/users/:id { password?, isAdmin?, isActive? }
router.patch('/users/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

    const isSelf = user._id.equals(req.user._id);
    const set = {};
    if (typeof req.body.isAdmin === 'boolean') set.isAdmin = req.body.isAdmin;
    if (typeof req.body.isActive === 'boolean') set.isActive = req.body.isActive;
    if (req.body.password !== undefined && req.body.password !== '') {
        if (!validPassword(req.body.password)) return res.status(400).json({ error: 'Şifre 6-72 karakter olmalı.' });
        set.passwordHash = await bcrypt.hash(req.body.password, 10);
    }

    // Kendini kilitleme ve admin'siz kalma engellenir
    if (isSelf && (set.isAdmin === false || set.isActive === false))
        return res.status(400).json({ error: 'Kendi adminliğini kaldıramaz ya da kendi hesabını kapatamazsın.' });
    const losesAdmin = user.isAdmin && (set.isAdmin === false || set.isActive === false);
    if (losesAdmin && !(await otherActiveAdminExists(user._id)))
        return res.status(400).json({ error: 'En az bir aktif admin kalmalı.' });

    if (!Object.keys(set).length) return res.json(userToClient(user));
    // Şifre değişirse kullanıcının açık oturumları kapanır
    const update = { $set: set };
    if (set.passwordHash) update.$inc = { tokenVersion: 1 };
    const updated = await User.findByIdAndUpdate(user._id, update, { returnDocument: 'after' }).lean();
    if (set.passwordHash || set.isActive === false) {
        await GameSession.deleteMany({ username: user.username });
        await PanelToken.deleteMany({ username: user.username });
    }
    res.json(userToClient(updated));
});

// DELETE /admin/users/:id
router.delete('/users/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    if (user._id.equals(req.user._id)) return res.status(400).json({ error: 'Kendi hesabını silemezsin.' });
    if (user.isAdmin && !(await otherActiveAdminExists(user._id)))
        return res.status(400).json({ error: 'En az bir aktif admin kalmalı.' });

    await User.deleteOne({ _id: user._id });
    await Avatar.deleteOne({ username: user.username });
    await require('../models/Banner').deleteOne({ username: user.username });
    await GameSession.deleteMany({ username: user.username });
    await PanelToken.deleteMany({ username: user.username });
    await MessageKey.deleteOne({ username: user.username });
    await Message.deleteMany({ $or: [{ from: user.username }, { to: user.username }] });
    await require('./shots').deleteAllBy(user.username);
    if (user.skinHash && !(await User.exists({ skinHash: user.skinHash }))) await Skin.deleteOne({ hash: user.skinHash });
    res.json({ success: true });
});

// GET /admin/registrations — bekleyen kayıt istekleri, eskiden yeniye
router.get('/registrations', async (req, res) => {
    const items = await Registration.find().sort({ createdAt: 1 }).lean();
    res.json(items.map(toClient));
});

// POST /admin/registrations/:id/approve — kullanıcıyı oluşturur, isteği siler
router.post('/registrations/:id/approve', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'İstek bulunamadı.' });
    const reg = await Registration.findById(req.params.id);
    if (!reg) return res.status(404).json({ error: 'İstek bulunamadı. Başka bir admin işlem yapmış olabilir.' });

    // İstek beklerken aynı adla elle bir kullanıcı açılmış olabilir
    if (await User.exists({ username: new RegExp(`^${reg.username}$`, 'i') })) {
        await Registration.deleteOne({ _id: reg._id });
        return res.status(409).json({ error: `"${reg.username}" adında bir kullanıcı zaten var; istek kaldırıldı.` });
    }

    const user = await User.create({
        username: reg.username,
        email: reg.email,
        passwordHash: reg.passwordHash,
        isActive: true,
        isAdmin: false,
    });
    await Registration.deleteOne({ _id: reg._id });
    res.json({ success: true, username: user.username });
});

// POST /admin/registrations/:id/reject — isteği siler
router.post('/registrations/:id/reject', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'İstek bulunamadı.' });
    const result = await Registration.deleteOne({ _id: req.params.id });
    if (!result.deletedCount) return res.status(404).json({ error: 'İstek bulunamadı. Başka bir admin işlem yapmış olabilir.' });
    res.json({ success: true });
});

module.exports = router;
