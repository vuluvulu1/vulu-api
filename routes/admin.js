const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Registration = require('../models/Registration');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const toClient = r => ({ id: String(r._id), username: r.username, email: r.email, createdAt: r.createdAt });

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
