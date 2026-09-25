const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Version = require('../models/Version');

const router = express.Router();

// POST /auth/login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password)
        return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli.' });

    const user = await User.findOne({ username });

    if (!user)
        return res.status(401).json({ error: 'Kullanıcı bulunamadı.' });

    if (!user.isActive)
        return res.status(403).json({ error: 'Hesabınız devre dışı.' });

    const valid = await bcrypt.compare(password, user.passwordHash);

    if (!valid)
        return res.status(401).json({ error: 'Şifre yanlış.' });

    const token = jwt.sign(
        { username: user.username, allowedPacks: user.allowedPacks },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );

    res.json({ token, allowedPacks: user.allowedPacks });
});

// POST /auth/create-user  (sadece sen kullanacaksın, admin işlemi)
router.post('/create-user', async (req, res) => {
    const { username, password, allowedPacks, adminKey } = req.body;

    // Basit bir admin koruması
    if (adminKey !== process.env.JWT_SECRET)
        return res.status(403).json({ error: 'Yetkisiz.' });

    const passwordHash = await bcrypt.hash(password, 10);

    const user = new User({ username, passwordHash, allowedPacks });
    await user.save();

    res.json({ success: true, username });
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
