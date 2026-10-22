const express = require('express');
const User = require('../models/User');
const Friendship = require('../models/Friendship');
const { requireAuth } = require('../middleware/auth');

// Arkadaşlık istekleri. Arkadaş olanlar birbirinin ne oynadığını görür (bkz. GET /users/presence).
const router = express.Router();
router.use(requireAuth);

const MAX_PENDING_OUT = 100;
const other = (row, me) => (row.a === me ? row.b : row.a);

// GET /friends — { friends, incoming, outgoing }: kullanıcı adları
router.get('/', async (req, res) => {
    const me = req.user.username;
    const rows = await Friendship.find({ $or: [{ a: me }, { b: me }] }).sort({ createdAt: -1 }).lean();
    res.json({
        friends: rows.filter(r => r.status === 'accepted').map(r => other(r, me)),
        incoming: rows.filter(r => r.status === 'pending' && r.from !== me).map(r => other(r, me)),
        outgoing: rows.filter(r => r.status === 'pending' && r.from === me).map(r => other(r, me)),
    });
});

// POST /friends/requests { username } — karşı taraf zaten istek göndermişse doğrudan arkadaş olunur
router.post('/requests', async (req, res) => {
    const me = req.user.username;
    const name = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const target = name && await User.findOne({ username: name, isActive: true }).select('username').lean();
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    if (target.username === me) return res.status(400).json({ error: 'Kendine arkadaşlık isteği gönderemezsin.' });

    const pair = Friendship.pair(me, target.username);
    const existing = await Friendship.findOne(pair);
    if (existing && existing.status === 'accepted') return res.status(409).json({ error: 'Zaten arkadaşsınız.' });
    if (existing && existing.from === me) return res.status(409).json({ error: 'İstek zaten gönderildi.' });
    if (existing) {
        existing.status = 'accepted';
        existing.acceptedAt = new Date();
        await existing.save();
        return res.json({ status: 'accepted', username: target.username });
    }
    if (await Friendship.countDocuments({ from: me, status: 'pending' }) >= MAX_PENDING_OUT)
        return res.status(429).json({ error: 'Çok fazla bekleyen isteğin var; bazılarını geri al.' });
    try { await Friendship.create({ ...pair, from: me }); }
    catch (err) { if (err.code !== 11000) throw err; }   // aynı anda iki istek: biri kalır
    res.status(201).json({ status: 'pending', username: target.username });
});

// POST /friends/requests/:username/accept
router.post('/requests/:username/accept', async (req, res) => {
    const me = req.user.username;
    const row = await Friendship.findOne({ ...Friendship.pair(me, req.params.username), status: 'pending', from: req.params.username });
    if (!row) return res.status(404).json({ error: 'Bekleyen bir istek yok.' });
    row.status = 'accepted';
    row.acceptedAt = new Date();
    await row.save();
    res.json({ status: 'accepted', username: req.params.username });
});

// DELETE /friends/requests/:username — gelen isteği reddet ya da gönderdiğini geri al
router.delete('/requests/:username', async (req, res) => {
    const result = await Friendship.deleteOne({ ...Friendship.pair(req.user.username, req.params.username), status: 'pending' });
    if (!result.deletedCount) return res.status(404).json({ error: 'Bekleyen bir istek yok.' });
    res.json({ success: true });
});

// DELETE /friends/:username — arkadaşlıktan çıkar
router.delete('/:username', async (req, res) => {
    const result = await Friendship.deleteOne({ ...Friendship.pair(req.user.username, req.params.username), status: 'accepted' });
    if (!result.deletedCount) return res.status(404).json({ error: 'Bu kişiyle arkadaş değilsiniz.' });
    res.json({ success: true });
});

module.exports = router;
