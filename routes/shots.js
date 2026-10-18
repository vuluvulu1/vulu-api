const express = require('express');
const mongoose = require('mongoose');
const { Readable } = require('stream');
const Shot = require('../models/Shot');
const ShotEvent = require('../models/ShotEvent');
const { requireAuth } = require('../middleware/auth');
const { createCounter } = require('../middleware/rateLimit');

/**
 * Ekran görüntüsü paylaşımı (Sosyal → Ekran görüntüleri). Yalnızca giriş yapmış üyeler görür.
 * Launcher resmi göndermeden önce WebP/JPEG'e çevirip küçültür; burada boyut ve tür denetlenir.
 * Veritabanı alanı sınırlı olduğundan toplam boyut SHOTS_CAP_MB'ı aşınca en eski görüntüler silinir.
 */
const router = express.Router();
router.use(requireAuth);

const BUCKET = 'shotfiles';
const MAX_IMAGE = 1.2 * 1024 * 1024;   // base64 + önizleme, genel 2 MB JSON sınırının altında kalır
const MAX_THUMB = 160 * 1024;
const CAP_BYTES = () => (Number(process.env.SHOTS_CAP_MB) || 150) * 1024 * 1024;
const PAGE = 24;
const postLimit = createCounter({ windowMs: 60 * 60 * 1000, max: 20 });
const commentLimit = createCounter({ windowMs: 10 * 60 * 1000, max: 30 });
const MAX_COMMENTS = 100;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });

/** Gövdedeki base64 resmi çözer; türünü dosyanın ilk baytlarından anlar (uzantıya/beyana güvenilmez). */
function decodeImage(value, max) {
    if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
    const buf = Buffer.from(value, 'base64');
    if (buf.length < 64 || buf.length > max) return null;
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { buf, type: 'image/webp' };
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { buf, type: 'image/jpeg' };
    return null;
}

function store(buf, name, metadata) {
    return new Promise((resolve, reject) => {
        const upload = bucket().openUploadStream(name, { metadata });
        Readable.from([buf]).pipe(upload).on('finish', () => resolve(upload.id)).on('error', reject);
    });
}

async function removeShot(shot) {
    await removeFiles(shot);
    await Shot.deleteOne({ _id: shot._id });
    await ShotEvent.deleteMany({ shot: shot._id });
}

async function removeFiles(shot) {
    for (const id of [shot.imageFileId, shot.thumbFileId]) {
        try { await bucket().delete(id); } catch { /* zaten yok */ }
    }
}

/** Toplam boyut sınırı aşıldıysa en eskiden başlayarak siler. */
async function prune() {
    const [{ total = 0 } = {}] = await Shot.aggregate([{ $group: { _id: null, total: { $sum: '$size' } } }]);
    let over = total - CAP_BYTES();
    if (over <= 0) return;
    const oldest = await Shot.find().sort({ createdAt: 1 }).select('imageFileId thumbFileId size').limit(200).lean();
    for (const shot of oldest) {
        if (over <= 0) break;
        await removeShot(shot);
        over -= shot.size;
    }
}

const toClient = (shot, me, admin) => ({
    id: String(shot._id),
    author: shot.author,
    caption: shot.caption || '',
    packName: shot.packName || '',
    packId: shot.packId || null,
    mcVersion: shot.mcVersion || '',
    width: shot.width, height: shot.height,
    likes: (shot.likes || []).length,
    liked: (shot.likes || []).includes(me),
    commentCount: (shot.comments || []).length,
    canDelete: shot.author === me || !!admin,
    createdAt: shot.createdAt,
});

// GET /shots?before=<ISO>&author=<ad> — en yeniden eskiye, sayfa sayfa
router.get('/', async (req, res) => {
    const filter = {};
    if (typeof req.query.author === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(req.query.author)) filter.author = req.query.author;
    const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
    if (before && !isNaN(before)) filter.createdAt = { $lt: before };
    const shots = await Shot.find(filter).sort({ createdAt: -1 }).limit(PAGE).select('-comments.text').lean();
    res.json({ shots: shots.map(s => toClient(s, req.user.username, req.user.isAdmin)), more: shots.length === PAGE });
});

// POST /shots { image, thumb (base64), caption, packName, packId, mcVersion, width, height }
router.post('/', async (req, res) => {
    const b = req.body || {};
    if (postLimit.hit(req.user.username)) return res.status(429).json({ error: 'Bir saatte en fazla 20 ekran görüntüsü paylaşılabilir.' });
    const image = decodeImage(b.image, MAX_IMAGE), thumb = decodeImage(b.thumb, MAX_THUMB);
    if (!image) return res.status(400).json({ error: 'Resim geçersiz ya da çok büyük.' });
    if (!thumb) return res.status(400).json({ error: 'Önizleme geçersiz.' });
    const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const dim = v => (Number.isInteger(v) && v > 0 && v <= 8192 ? v : 0);

    const meta = { author: req.user.username };
    const imageFileId = await store(image.buf, 'shot', meta);
    let thumbFileId;
    try { thumbFileId = await store(thumb.buf, 'thumb', meta); }
    catch (err) { await bucket().delete(imageFileId).catch(() => { }); throw err; }

    const shot = await Shot.create({
        author: req.user.username,
        caption: text(b.caption, 200),
        packName: text(b.packName, 64),
        packId: typeof b.packId === 'string' && mongoose.isValidObjectId(b.packId) ? b.packId : null,
        mcVersion: typeof b.mcVersion === 'string' && VERSION.test(b.mcVersion) ? b.mcVersion : '',
        imageFileId, thumbFileId, imageType: image.type, thumbType: thumb.type,
        width: dim(b.width), height: dim(b.height),
        size: image.buf.length + thumb.buf.length,
    });
    prune().catch(err => console.error('Ekran görüntüsü temizliği:', err.message));
    res.status(201).json(toClient(shot.toObject(), req.user.username, req.user.isAdmin));
});

async function findShot(id) {
    return mongoose.isValidObjectId(id) ? Shot.findById(id).lean() : null;
}

// GET /shots/:id/image ve /shots/:id/thumb
for (const [path, field] of [['image', 'imageFileId'], ['thumb', 'thumbFileId']]) {
    router.get(`/:id/${path}`, async (req, res) => {
        const shot = await findShot(req.params.id);
        if (!shot) return res.status(404).json({ error: 'Ekran görüntüsü bulunamadı.' });
        res.set('Content-Type', field === 'thumbFileId' ? shot.thumbType || shot.imageType : shot.imageType);
        res.set('Cache-Control', 'private, max-age=31536000, immutable');
        bucket().openDownloadStream(shot[field])
            .on('error', () => { if (!res.headersSent) res.status(404); res.end(); })
            .pipe(res);
    });
}

// GET /shots/events?since=<ISO> — ekran görüntülerime gelen beğeni ve yorumlar (launcher yoklar)
router.get('/events', async (req, res) => {
    const now = new Date();
    const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
    const filter = { to: req.user.username, createdAt: { $gt: since && !isNaN(since) ? since : new Date(now - 60 * 1000), $lte: now } };
    const events = await ShotEvent.find(filter).sort({ createdAt: 1 }).limit(50).lean();
    res.json({
        events: events.map(e => ({ id: String(e._id), from: e.from, shotId: String(e.shot), kind: e.kind, text: e.text, createdAt: e.createdAt })),
        now,
    });
});

// GET /shots/:id — tek bir ekran görüntüsü (bildirimden açılınca)
router.get('/:id', async (req, res) => {
    const shot = await findShot(req.params.id);
    if (!shot) return res.status(404).json({ error: 'Ekran görüntüsü bulunamadı.' });
    res.json(toClient(shot, req.user.username, req.user.isAdmin));
});

// GET /shots/:id/comments — eskiden yeniye
router.get('/:id/comments', async (req, res) => {
    const shot = await findShot(req.params.id);
    if (!shot) return res.status(404).json({ error: 'Ekran görüntüsü bulunamadı.' });
    const me = req.user.username;
    res.json((shot.comments || []).map(c => ({
        id: String(c._id), author: c.author, text: c.text, createdAt: c.createdAt,
        canDelete: c.author === me || shot.author === me || !!req.user.isAdmin,
    })));
});

// POST /shots/:id/comments { text }
router.post('/:id/comments', async (req, res) => {
    if (commentLimit.hit(req.user.username)) return res.status(429).json({ error: 'Çok hızlı yorum yazıyorsun, biraz bekle.' });
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (text.length < 1 || text.length > 300) return res.status(400).json({ error: 'Yorum 1-300 karakter olmalı.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Ekran görüntüsü bulunamadı.' });
    const comment = { _id: new mongoose.Types.ObjectId(), author: req.user.username, text, createdAt: new Date() };
    const shot = await Shot.findOneAndUpdate(
        { _id: req.params.id, [`comments.${MAX_COMMENTS - 1}`]: { $exists: false } },
        { $push: { comments: comment } }, { returnDocument: 'after' }).lean();
    if (!shot) {
        const exists = await Shot.exists({ _id: req.params.id });
        return exists ? res.status(400).json({ error: 'Bu ekran görüntüsü yorum sınırına ulaştı.' }) : res.status(404).json({ error: 'Ekran görüntüsü bulunamadı.' });
    }
    if (shot.author !== req.user.username)
        await ShotEvent.create({ to: shot.author, from: req.user.username, shot: shot._id, kind: 'comment', text: text.slice(0, 120) });
    res.status(201).json({ id: String(comment._id), author: comment.author, text, createdAt: comment.createdAt, canDelete: true, commentCount: shot.comments.length });
});

// DELETE /shots/:id/comments/:commentId — yorumu yazan, görüntünün sahibi ya da admin
router.delete('/:id/comments/:commentId', async (req, res) => {
    const shot = await findShot(req.params.id);
    const comment = shot && mongoose.isValidObjectId(req.params.commentId) && (shot.comments || []).find(c => String(c._id) === req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Yorum bulunamadı.' });
    const me = req.user.username;
    if (comment.author !== me && shot.author !== me && !req.user.isAdmin) return res.status(403).json({ error: 'Bu yorumu silemezsin.' });
    await Shot.updateOne({ _id: shot._id }, { $pull: { comments: { _id: comment._id } } });
    res.json({ success: true });
});

// POST /shots/:id/like { like: true|false }
router.post('/:id/like', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Ekran görüntüsü bulunamadı.' });
    const op = req.body?.like === false ? { $pull: { likes: req.user.username } } : { $addToSet: { likes: req.user.username } };
    const shot = await Shot.findByIdAndUpdate(req.params.id, op, { returnDocument: 'after' }).select('author likes').lean();
    if (!shot) return res.status(404).json({ error: 'Ekran görüntüsü bulunamadı.' });
    // Beğeni bildirimi: kişi başına bir tane; vazgeçilince silinir (beğen-vazgeç tekrarı bildirim yağdırmasın)
    if (shot.author !== req.user.username) {
        const key = { to: shot.author, from: req.user.username, shot: shot._id, kind: 'like' };
        if (req.body?.like === false) await ShotEvent.deleteOne(key);
        else await ShotEvent.updateOne(key, { $setOnInsert: { ...key, createdAt: new Date() } }, { upsert: true });
    }
    res.json({ likes: shot.likes.length, liked: shot.likes.includes(req.user.username) });
});

// DELETE /shots/:id — paylaşan ya da admin
router.delete('/:id', async (req, res) => {
    const shot = await findShot(req.params.id);
    if (!shot) return res.status(404).json({ error: 'Ekran görüntüsü bulunamadı.' });
    if (shot.author !== req.user.username && !req.user.isAdmin) return res.status(403).json({ error: 'Yalnızca paylaşan kişi ya da admin silebilir.' });
    await removeShot(shot);
    res.json({ success: true });
});

/** Kullanıcı silinince paylaştıkları da gider (admin.js çağırır). */
router.deleteAllBy = async username => {
    const shots = await Shot.find({ author: username }).select('imageFileId thumbFileId').lean();
    for (const shot of shots) await removeShot(shot);
    await Shot.updateMany({ likes: username }, { $pull: { likes: username } });
    await Shot.updateMany({ 'comments.author': username }, { $pull: { comments: { author: username } } });
    await ShotEvent.deleteMany({ $or: [{ to: username }, { from: username }] });
};

module.exports = router;
