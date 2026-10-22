const express = require('express');
const mongoose = require('mongoose');
const Feedback = require('../models/Feedback');
const Pack = require('../models/Pack');
const { canSeePack, visiblePacksQuery } = require('../lib/access');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const GENERAL = 'general';          // pakete bağlı olmayan paket istekleri
const LAUNCHER = 'launcher';        // launcher'ın kendisi hakkında: hata ve öneri
const KINDS = { packs: ['feedback', 'request'], launcher: ['bug', 'idea'] };
const MAX_TEXT = 1000;
const MAX_REPLY = 500;
const POST_INTERVAL_MS = 15 * 1000; // aynı kullanıcı arka arkaya gönderemez
const MAX_OPEN_PER_USER = 30;

/** ?pack= değerini filtreye çevirir; geçersizse null. (area alanı olmayan eski kayıtlar paketlere aittir.) */
function packFilter(value) {
    if (value === LAUNCHER) return { pack: null, area: LAUNCHER };
    if (!value || value === GENERAL) return { pack: null, area: { $ne: LAUNCHER } };
    if (!mongoose.isValidObjectId(value)) return null;
    return { pack: new mongoose.Types.ObjectId(String(value)) };
}

function toClient(item, user, avatars) {
    return {
        id: String(item._id),
        pack: item.area === LAUNCHER ? LAUNCHER : item.pack ? String(item.pack) : GENERAL,
        kind: item.kind,
        ...(user.isAdmin && item.meta ? { meta: { version: item.meta.version || '', platform: item.meta.platform || '' } } : {}),
        text: item.text,
        author: item.author,
        authorAvatarVersion: avatars.get(item.author) || 0,
        status: item.status,
        reply: item.reply || '',
        repliedBy: item.repliedBy || '',
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        mine: String(item.authorId) === String(user._id),
        canDelete: String(item.authorId) === String(user._id) || !!user.isAdmin,
    };
}

async function avatarVersions(items) {
    const names = [...new Set(items.map(i => i.author))];
    const users = await User.find({ username: { $in: names } }).select('username avatarVersion').lean();
    return new Map(users.map(u => [u.username, u.avatarVersion || 0]));
}

// GET /feedback/counts — paket başına açık geri bildirim sayısı (kartlardaki rozet için)
router.get('/counts', requireAuth, async (req, res) => {
    // Görülemeyen paketlerin sayısı verilmez
    const visible = (await Pack.find(visiblePacksQuery(req.user)).select('_id').lean()).map(p => p._id);
    const rows = await Feedback.aggregate([
        { $match: { status: 'open', $or: [{ pack: null }, { pack: { $in: visible } }] } },
        { $group: { _id: { pack: '$pack', launcher: { $eq: ['$area', LAUNCHER] } }, count: { $sum: 1 } } },
    ]);
    const counts = {};
    for (const row of rows) counts[row._id.launcher ? LAUNCHER : row._id.pack ? String(row._id.pack) : GENERAL] = row.count;
    res.json(counts);
});

// GET /feedback?pack=<id|general>
router.get('/', requireAuth, async (req, res) => {
    const filter = packFilter(req.query.pack);
    if (!filter) return res.status(400).json({ error: 'Geçersiz paket.' });
    if (filter.pack && !canSeePack(req.user, await Pack.findById(filter.pack).select('roles').lean()))
        return res.status(404).json({ error: 'Paket bulunamadı.' });

    // Açıklar önce, sonra en yeniler
    const items = await Feedback.find(filter).sort({ status: -1, createdAt: -1 }).limit(300).lean();
    const avatars = await avatarVersions(items);
    res.json(items.map(i => toClient(i, req.user, avatars)));
});

// POST /feedback { pack, kind, text }
router.post('/', requireAuth, async (req, res) => {
    const text = String(req.body.text || '').trim();
    const area = req.body.pack === LAUNCHER ? LAUNCHER : 'packs';
    const kind = KINDS[area].includes(req.body.kind) ? req.body.kind : KINDS[area][area === LAUNCHER ? 1 : 0];
    if (text.length < 3) return res.status(400).json({ error: 'Biraz daha yaz.' });
    if (text.length > MAX_TEXT) return res.status(400).json({ error: `En fazla ${MAX_TEXT} karakter yazabilirsin.` });

    const filter = packFilter(req.body.pack);
    if (!filter) return res.status(400).json({ error: 'Geçersiz paket.' });
    if (filter.pack && !canSeePack(req.user, await Pack.findById(filter.pack).select('roles').lean()))
        return res.status(404).json({ error: 'Paket bulunamadı.' });

    const last = await Feedback.findOne({ authorId: req.user._id }).sort({ createdAt: -1 }).select('createdAt').lean();
    if (last && Date.now() - new Date(last.createdAt).getTime() < POST_INTERVAL_MS)
        return res.status(429).json({ error: 'Biraz bekleyip tekrar dene.' });

    const open = await Feedback.countDocuments({ authorId: req.user._id, status: 'open' });
    if (open >= MAX_OPEN_PER_USER)
        return res.status(429).json({ error: 'Çok fazla açık geri bildirimin var. Eskilerden bazılarını sil.' });

    const short = v => (typeof v === 'string' ? v.trim().slice(0, 40) : '');
    const meta = area === LAUNCHER && req.body.meta ? { version: short(req.body.meta.version), platform: short(req.body.meta.platform) } : undefined;
    const item = await Feedback.create({
        area, pack: filter.pack, kind, text, meta,
        author: req.user.username, authorId: req.user._id,
    });
    res.status(201).json(toClient(item.toObject(), req.user, new Map([[req.user.username, req.user.avatarVersion || 0]])));
});

// PATCH /feedback/:id { status?, reply? } — yalnızca admin
router.patch('/:id', requireAuth, async (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Bu işlem için admin yetkisi gerekli.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Bulunamadı.' });

    const set = { updatedAt: new Date() };
    if (req.body.status !== undefined) {
        if (!['open', 'done'].includes(req.body.status)) return res.status(400).json({ error: 'Geçersiz durum.' });
        set.status = req.body.status;
    }
    if (req.body.reply !== undefined) {
        const reply = String(req.body.reply || '').trim();
        if (reply.length > MAX_REPLY) return res.status(400).json({ error: `Yanıt en fazla ${MAX_REPLY} karakter olabilir.` });
        set.reply = reply;
        set.repliedBy = reply ? req.user.username : '';
    }

    const item = await Feedback.findByIdAndUpdate(req.params.id, { $set: set }, { returnDocument: 'after' }).lean();
    if (!item) return res.status(404).json({ error: 'Bulunamadı.' });
    res.json(toClient(item, req.user, await avatarVersions([item])));
});

// DELETE /feedback/:id — yazan kişi ya da admin
router.delete('/:id', requireAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Bulunamadı.' });
    const item = await Feedback.findById(req.params.id).select('authorId').lean();
    if (!item) return res.status(404).json({ error: 'Bulunamadı.' });
    if (String(item.authorId) !== String(req.user._id) && !req.user.isAdmin)
        return res.status(403).json({ error: 'Yalnızca kendi yazdıklarını silebilirsin.' });

    await Feedback.deleteOne({ _id: item._id });
    res.json({ success: true });
});

module.exports = router;
