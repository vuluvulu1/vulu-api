const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Message = require('../models/Message');
const MessageKey = require('../models/MessageKey');
const { requireAuth } = require('../middleware/auth');
const { createCounter } = require('../middleware/rateLimit');

/**
 * Uçtan uca şifreli direkt mesajlar. Şifreleme ve çözme yalnızca launcher'da yapılır; burada içerik okunamaz.
 * Sunucu: açık anahtarları dağıtır, gizli anahtarların şifreli yedeğini tutar, şifreli mesajları iletir.
 */
const router = express.Router();
router.use(requireAuth);

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const NAME = /^[A-Za-z0-9_]{3,16}$/;
const MAX_CIPHER = 12 * 1024;                  // ~8 KB metin (base64 + etiket)
const sendLimit = createCounter({ windowMs: 60 * 1000, max: 30 });

const b64 = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && B64.test(v);
const keyIdOf = publicKey => crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);

function validPublicKey(spki) {
    try {
        const key = crypto.createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
        return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
    } catch { return false; }
}

const toClient = m => ({
    id: String(m._id), from: m.from, to: m.to, cipher: m.cipher, nonce: m.nonce, salt: m.salt,
    senderKeyId: m.senderKeyId, recipientKeyId: m.recipientKeyId, createdAt: m.createdAt, readAt: m.readAt,
});

// ── Anahtarlar ────────────────────────────────────────────────────────
// GET /messages/keys/me — kendi açık anahtarım ve şifreli yedeğim (yoksa 404)
router.get('/keys/me', async (req, res) => {
    const key = await MessageKey.findOne({ username: req.user.username }).lean();
    if (!key) return res.status(404).json({ error: 'Anahtar yok.' });
    res.json({ publicKey: key.publicKey, keyId: key.keyId, backup: key.backup, updatedAt: key.updatedAt });
});

// PUT /messages/keys/me { publicKey, backup: { cipher, nonce, salt, iterations } }
// İlk kurulumda, şifre değişince (yedek yeni şifreyle) ya da yeni anahtar üretilince çağrılır.
router.put('/keys/me', async (req, res) => {
    const { publicKey, backup } = req.body || {};
    if (!b64(publicKey, 80, 200) || !validPublicKey(publicKey)) return res.status(400).json({ error: 'Açık anahtar geçersiz.' });
    if (!backup || !b64(backup.cipher, 40, 1000) || !b64(backup.nonce, 16, 16) || !b64(backup.salt, 24, 44)
        || !Number.isInteger(backup.iterations) || backup.iterations < 100000 || backup.iterations > 5000000)
        return res.status(400).json({ error: 'Anahtar yedeği geçersiz.' });
    const keyId = keyIdOf(publicKey);
    await MessageKey.updateOne({ username: req.user.username },
        { $set: { publicKey, keyId, backup: { cipher: backup.cipher, nonce: backup.nonce, salt: backup.salt, iterations: backup.iterations }, updatedAt: new Date() } },
        { upsert: true });
    res.json({ keyId });
});

// GET /messages/keys/:username — bir kullanıcının açık anahtarı
router.get('/keys/:username', async (req, res) => {
    if (!NAME.test(req.params.username)) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const key = await MessageKey.findOne({ username: req.params.username }).lean();
    if (!key) return res.status(404).json({ error: 'Bu kullanıcı henüz mesajlaşmayı kullanmadı.' });
    res.json({ username: key.username, publicKey: key.publicKey, keyId: key.keyId, updatedAt: key.updatedAt });
});

// ── Mesajlar ──────────────────────────────────────────────────────────
// POST /messages { to, cipher, nonce, salt, senderKeyId, recipientKeyId }
router.post('/', async (req, res) => {
    const b = req.body || {};
    if (sendLimit.hit(req.user.username)) return res.status(429).json({ error: 'Çok hızlı mesaj gönderiyorsun, biraz bekle.' });
    if (typeof b.to !== 'string' || !NAME.test(b.to)) return res.status(400).json({ error: 'Alıcı geçersiz.' });
    if (b.to === req.user.username) return res.status(400).json({ error: 'Kendine mesaj gönderemezsin.' });
    if (!b64(b.cipher, 24, MAX_CIPHER) || !b64(b.nonce, 16, 16) || !b64(b.salt, 24, 24)
        || typeof b.senderKeyId !== 'string' || !/^[0-9a-f]{16}$/.test(b.senderKeyId)
        || typeof b.recipientKeyId !== 'string' || !/^[0-9a-f]{16}$/.test(b.recipientKeyId))
        return res.status(400).json({ error: 'Mesaj geçersiz.' });

    const [recipient, myKey, theirKey] = await Promise.all([
        User.findOne({ username: b.to, isActive: { $ne: false } }).select('username').lean(),
        MessageKey.findOne({ username: req.user.username }).select('keyId').lean(),
        MessageKey.findOne({ username: b.to }).select('keyId').lean(),
    ]);
    if (!recipient) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    // Eski bir anahtarla şifrelenmiş mesaj kabul edilmez: launcher güncel anahtarı alıp yeniden şifreler
    if (!myKey || myKey.keyId !== b.senderKeyId || !theirKey || theirKey.keyId !== b.recipientKeyId)
        return res.status(409).json({ error: 'Anahtarlar değişmiş; mesaj yeniden şifrelenmeli.', code: 'KEY_CHANGED' });

    const message = await Message.create({
        from: req.user.username, to: recipient.username, cipher: b.cipher, nonce: b.nonce, salt: b.salt,
        senderKeyId: b.senderKeyId, recipientKeyId: b.recipientKeyId,
    });
    res.status(201).json(toClient(message));
});

// GET /messages/conversations — kiminle yazışıldığı, son mesaj zamanı, okunmamış sayısı
router.get('/conversations', async (req, res) => {
    const me = req.user.username;
    const rows = await Message.aggregate([
        { $match: { $or: [{ from: me }, { to: me }] } },
        { $project: { peer: { $cond: [{ $eq: ['$from', me] }, '$to', '$from'] }, createdAt: 1, unread: { $and: [{ $eq: ['$to', me] }, { $eq: ['$readAt', null] }] } } },
        { $group: { _id: '$peer', lastAt: { $max: '$createdAt' }, unread: { $sum: { $cond: ['$unread', 1, 0] } } } },
        { $sort: { lastAt: -1 } },
        { $limit: 100 },
    ]);
    res.json(rows.map(r => ({ username: r._id, lastAt: r.lastAt, unread: r.unread })));
});

// GET /messages/with/:username?before=<ISO>&limit=50 — bir kişiyle yazışma, yeniden eskiye
router.get('/with/:username', async (req, res) => {
    if (!NAME.test(req.params.username)) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const me = req.user.username, peer = req.params.username;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = { $or: [{ from: me, to: peer }, { from: peer, to: me }] };
    const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
    if (before && !isNaN(before)) filter.createdAt = { $lt: before };
    const messages = await Message.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(messages.map(toClient));
});

// GET /messages/updates?since=<ISO> — bana gelen yeni mesajlar ve okunmamış toplamı (launcher birkaç saniyede bir sorar)
router.get('/updates', async (req, res) => {
    const me = req.user.username;
    const now = new Date();   // sorgudan önce alınır; sorgu sırasında gelen mesaj bir sonraki yoklamada kaçmasın
    const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
    const filter = { to: me };
    if (since && !isNaN(since)) filter.createdAt = { $gt: since, $lte: now };
    else filter.createdAt = { $gt: new Date(now - 60 * 1000), $lte: now };
    const [messages, unread] = await Promise.all([
        Message.find(filter).sort({ createdAt: 1 }).limit(100).lean(),
        Message.countDocuments({ to: me, readAt: null }),
    ]);
    res.json({ messages: messages.map(toClient), unread, now });
});

// POST /messages/with/:username/read — bu kişiden gelenler okundu
router.post('/with/:username/read', async (req, res) => {
    if (!NAME.test(req.params.username)) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const result = await Message.updateMany({ from: req.params.username, to: req.user.username, readAt: null }, { $set: { readAt: new Date() } });
    res.json({ updated: result.modifiedCount });
});

// DELETE /messages/:id — kendi gönderdiğim mesajı herkesten sil
router.delete('/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Mesaj bulunamadı.' });
    const result = await Message.deleteOne({ _id: req.params.id, from: req.user.username });
    if (!result.deletedCount) return res.status(404).json({ error: 'Mesaj bulunamadı.' });
    res.json({ success: true });
});

module.exports = router;
