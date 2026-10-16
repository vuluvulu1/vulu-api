const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Registration = require('../models/Registration');
const Version = require('../models/Version');

const router = express.Router();

// POST /auth/login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password)
        return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli.' });

    const user = await User.findOne({ username });

    if (!user) {
        if (await Registration.exists({ username }))
            return res.status(403).json({ error: 'Kaydın henüz onaylanmadı. Bir admin onayladığında giriş yapabilirsin.' });
        return res.status(401).json({ error: 'Kullanıcı bulunamadı.' });
    }

    if (!user.isActive)
        return res.status(403).json({ error: 'Hesabınız devre dışı.' });

    const valid = await bcrypt.compare(password, user.passwordHash);

    if (!valid)
        return res.status(401).json({ error: 'Şifre yanlış.' });

    // Topluluk listesinde "son görülme" için. Yalnızca bu alan yazılır (eski kayıtlar şemaya tam uymasa da
    // sorun çıkmaz) ve beklenmez: kaydedilemese bile giriş engellenmez.
    User.updateOne({ _id: user._id }, { $set: { lastSeenAt: new Date() } })
        .catch(err => console.error('lastSeenAt yazılamadı:', err.message));

        const token = jwt.sign(
        {
            username: user.username,
            isAdmin: user.isAdmin
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );

    res.json({
        token,
        isAdmin: user.isAdmin
    });
});

// POST /auth/register { username, email, password } — kayıt isteği; bir admin onaylayınca hesap açılır.
// (Eskiden gizli anahtarla hesap açan /auth/create-user vardı; yerini bu ve admin onayı aldı.)
const USERNAME = /^[A-Za-z0-9_]{3,16}$/;   // Minecraft çevrimdışı oturumunun kabul ettiği karakterler
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PENDING = 50;                   // toplam bekleyen istek
const MAX_PER_IP_PER_DAY = 3;

const sameName = name => new RegExp(`^${name}$`, 'i'); // ad yalnızca harf/rakam/_ içerdiği için güvenli

router.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!USERNAME.test(username))
        return res.status(400).json({ error: 'Kullanıcı adı 3-16 karakter olmalı; yalnızca İngilizce harf, rakam ve _ kullanılabilir.' });
    if (email.length > 254 || !EMAIL.test(email))
        return res.status(400).json({ error: 'Geçerli bir e-posta adresi gir.' });
    if (password.length < 6 || password.length > 100)
        return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı.' });

    if (await User.exists({ username: sameName(username) }))
        return res.status(409).json({ error: 'Bu kullanıcı adı alınmış.' });
    if (await Registration.exists({ username: sameName(username) }))
        return res.status(409).json({ error: 'Bu kullanıcı adıyla bekleyen bir kayıt isteği var.' });
    if (await User.exists({ email }) || await Registration.exists({ email }))
        return res.status(409).json({ error: 'Bu e-posta adresiyle zaten bir hesap ya da kayıt isteği var.' });

    const ip = req.ip || '';
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (await Registration.countDocuments() >= MAX_PENDING
        || (ip && await Registration.countDocuments({ ip, createdAt: { $gte: since } }) >= MAX_PER_IP_PER_DAY))
        return res.status(429).json({ error: 'Şu an çok fazla kayıt isteği var. Daha sonra tekrar dene.' });

    await Registration.create({ username, email, passwordHash: await bcrypt.hash(password, 10), ip });
    res.status(201).json({ success: true });
});

// GET /auth/version
router.get('/version', async (req, res) => {
    try {
        const latest = await Version.findOne();
        if (!latest) return res.status(404).json({ error: 'Sürüm bulunamadı.' });
        res.json({ version: latest.version, downloadUrl: latest.downloadUrl });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası.' });
    }
});

module.exports = router;
