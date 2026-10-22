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
const Role = require('../models/Role');
const Pack = require('../models/Pack');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// emailVerified: alanı olmayan (e-posta doğrulamasından önceki) istekler doğrulanmış sayılır
const toClient = r => ({ id: String(r._id), username: r.username, email: r.email, createdAt: r.createdAt, emailVerified: r.emailVerified !== false });

// ── Veritabanı alanı ──────────────────────────────────────────────────
// Atlas'ın ücretsiz kümesi 512 MB; başka bir plan kullanılıyorsa DB_LIMIT_MB ile değiştirilir
const DB_LIMIT_MB = () => Number(process.env.DB_LIMIT_MB) || 512;

/** Bir koleksiyondaki belgelerin bayt toplamı ($bsonSize) ve sayısı; koleksiyon yoksa sıfır. */
async function collectionUsage(db, name, match = {}) {
    try {
        const [row] = await db.collection(name).aggregate([
            { $match: match },
            { $group: { _id: null, bytes: { $sum: { $bsonSize: '$$ROOT' } }, count: { $sum: 1 } } },
        ]).toArray();
        return { bytes: row?.bytes || 0, count: row?.count || 0 };
    } catch { return { bytes: 0, count: 0 }; }
}

// GET /admin/storage — veritabanının ne kadarı dolu, neye harcanıyor
router.get('/storage', async (req, res) => {
    const db = mongoose.connection.db;
    const sum = async (...names) => {
        const parts = await Promise.all(names.map(n => collectionUsage(db, n)));
        return { bytes: parts.reduce((a, p) => a + p.bytes, 0), count: parts[0].count };
    };
    // GridFS dosyalarının boyutu dosya kayıtlarında yazılı; parçaları taramaya gerek yok
    const gridfs = async bucket => {
        try {
            const [row] = await db.collection(`${bucket}.files`).aggregate([{ $group: { _id: null, bytes: { $sum: '$length' }, count: { $sum: 1 } } }]).toArray();
            return { bytes: row?.bytes || 0, count: row?.count || 0 };
        } catch { return { bytes: 0, count: 0 }; }
    };
    const [packFiles, shotFiles, avatars, banners, skins, messages, total] = await Promise.all([
        gridfs('packfiles'),
        gridfs('shotfiles'),
        sum('avatars'), sum('banners'), sum('skins'), sum('messages', 'messagekeys'),
        db.stats().catch(() => null),
    ]);
    const used = total ? (total.dataSize || 0) + (total.indexSize || 0) : null;
    res.json({
        limitBytes: DB_LIMIT_MB() * 1024 * 1024,
        usedBytes: used,
        parts: [
            { key: 'packs', label: 'Paket dosyaları', bytes: packFiles.bytes },
            { key: 'shots', label: 'Ekran görüntüleri', bytes: shotFiles.bytes },
            { key: 'images', label: 'Avatar, banner ve skinler', bytes: avatars.bytes + banners.bytes + skins.bytes },
            { key: 'messages', label: 'Mesajlar', bytes: messages.bytes },
        ],
    });
});

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
    roles: (u.roles || []).map(String),
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

// PATCH /admin/users/:id { password?, isAdmin?, isActive?, roles? }
router.patch('/users/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

    const isSelf = user._id.equals(req.user._id);
    const set = {};
    if (typeof req.body.isAdmin === 'boolean') set.isAdmin = req.body.isAdmin;
    if (typeof req.body.isActive === 'boolean') set.isActive = req.body.isActive;
    if (req.body.roles !== undefined) {
        if (!Array.isArray(req.body.roles) || req.body.roles.length > 50 || req.body.roles.some(r => !mongoose.isValidObjectId(r)))
            return res.status(400).json({ error: 'Rol listesi geçersiz.' });
        const roles = [...new Set(req.body.roles.map(String))];
        if (await Role.countDocuments({ _id: { $in: roles } }) !== roles.length)
            return res.status(400).json({ error: 'Seçilen rollerden biri artık yok; listeyi yenileyip tekrar dene.' });
        set.roles = roles;
    }
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

// ── Roller ────────────────────────────────────────────────────────────
// Paketlere erişimi sınırlar (bkz. lib/access.js) ve profillerde rozet olarak görünür.
const ROLE_COLOR = /^#[0-9a-f]{6}$/i;
const MAX_ROLES = 50;
const roleToClient = (r, counts = {}) => ({
    id: String(r._id), name: r.name, color: r.color, createdAt: r.createdAt,
    members: counts.members?.[String(r._id)] || 0, packs: counts.packs?.[String(r._id)] || 0,
});

function cleanRole(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 24) return { error: 'Rol adı 1-24 karakter olmalı.' };
    const color = typeof body.color === 'string' && ROLE_COLOR.test(body.color) ? body.color.toLowerCase() : '#9c704c';
    return { value: { name, key: name.toLocaleLowerCase('tr'), color } };
}

async function roleUsage() {
    const count = async Model => Object.fromEntries((await Model.aggregate([
        { $unwind: '$roles' }, { $group: { _id: '$roles', n: { $sum: 1 } } },
    ])).map(r => [String(r._id), r.n]));
    return { members: await count(User), packs: await count(Pack) };
}

// GET /admin/roles — her rol, kaç kişide ve kaç pakette kullanıldığıyla
router.get('/roles', async (req, res) => {
    const [roles, usage] = await Promise.all([Role.find().sort({ createdAt: 1 }).lean(), roleUsage()]);
    res.json(roles.map(r => roleToClient(r, usage)));
});

// POST /admin/roles { name, color }
router.post('/roles', async (req, res) => {
    const { value, error } = cleanRole(req.body || {});
    if (error) return res.status(400).json({ error });
    if (await Role.countDocuments() >= MAX_ROLES) return res.status(400).json({ error: `En fazla ${MAX_ROLES} rol oluşturulabilir.` });
    if (await Role.exists({ key: value.key })) return res.status(409).json({ error: 'Bu adda bir rol zaten var.' });
    res.status(201).json(roleToClient(await Role.create(value)));
});

// PATCH /admin/roles/:id { name?, color? }
router.patch('/roles/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Rol bulunamadı.' });
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ error: 'Rol bulunamadı.' });
    const { value, error } = cleanRole({ name: req.body.name ?? role.name, color: req.body.color ?? role.color });
    if (error) return res.status(400).json({ error });
    if (value.key !== role.key && await Role.exists({ key: value.key })) return res.status(409).json({ error: 'Bu adda bir rol zaten var.' });
    Object.assign(role, value);
    await role.save();
    res.json(roleToClient(role, await roleUsage()));
});

// DELETE /admin/roles/:id — bir pakete erişimi belirleyen rol silinemez (silinirse paket herkese açılabilirdi)
router.delete('/roles/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Rol bulunamadı.' });
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ error: 'Rol bulunamadı.' });
    const packs = await Pack.find({ roles: role._id }).select('name').lean();
    if (packs.length)
        return res.status(409).json({ error: `Bu rol şu paketlerin erişimini belirliyor: ${packs.map(p => p.name).join(', ')}. Önce paketlerden kaldır.` });
    await User.updateMany({ roles: role._id }, { $pull: { roles: role._id } });
    await Role.deleteOne({ _id: role._id });
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
    if (reg.emailVerified === false)
        return res.status(409).json({ error: `${reg.username} e-posta adresini henüz doğrulamadı. Doğrulayınca onaylayabilirsin.` });

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
