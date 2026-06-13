const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Version = require('../models/Version');

const authenticateAdmin = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token gerekli.' });
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.isAdmin) return res.status(403).json({ error: 'Yetkisiz.' });
        req.user = decoded;
        next();
    } catch {
        res.status(401).json({ error: 'Geçersiz token.' });
    }
};

const router = express.Router();

// GET /auth/users — tüm kullanıcıları listele
router.get('/users', authenticateAdmin, async (req, res) => {
    const users = await User.find({}, '-passwordHash');
    res.json(users);
});

// POST /auth/users — yeni kullanıcı ekle
router.post('/users', authenticateAdmin, async (req, res) => {
    const { username, password, allowedPacks, isAdmin } = req.body;
    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({ username, passwordHash, allowedPacks, isAdmin: isAdmin ?? false });
    await user.save();
    res.json({ success: true });
});

// PATCH /auth/users/:id — kullanıcı güncelle
router.patch('/users/:id', authenticateAdmin, async (req, res) => {
    const { password, allowedPacks, isActive, isAdmin } = req.body;
    const update = { allowedPacks, isActive, isAdmin };
    if (password) update.passwordHash = await bcrypt.hash(password, 10);
    await User.findByIdAndUpdate(req.params.id, update);
    res.json({ success: true });
});

// DELETE /auth/users/:id — kullanıcı sil
router.delete('/users/:id', authenticateAdmin, async (req, res) => {
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

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
    { username: user.username, allowedPacks: user.allowedPacks, isAdmin: user.isAdmin },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
    );

    res.json({ token, allowedPacks: user.allowedPacks, isAdmin: user.isAdmin });
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
