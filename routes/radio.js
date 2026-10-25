const express = require('express');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Song = require('../models/Song');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/**
 * vulu Radyo: adminlerin yüklediği şarkılar. Üyeler listeyi ve dosyaları alır; launcher dosyayı bir kez indirip
 * kendi önbelleğinden çalar. Yalnızca hakları alınmış ya da telifsiz şarkılar yüklenmeli (admin panelinde yazar).
 *
 * Dosyalar veritabanına değil sunucu diskine yazılır: RADIO_DIR (ör. /srv/vulu-api/radio; her dağıtımda değişen
 * uygulama klasörünün dışında olmalı). Ayarlı değilse yükleme açıkça reddedilir. Dosya türü uzantıdan değil ilk
 * baytlardan anlaşılır; toplam alan RADIO_CAP_MB ile sınırlıdır (dolunca yükleme reddedilir).
 */
const router = express.Router();
router.use(requireAuth);

const MAX_FILE = 30 * 1024 * 1024;
const CAP_BYTES = () => (Number(process.env.RADIO_CAP_MB) || 2048) * 1024 * 1024;
const MAX_TEXT = 100;
const radioDir = () => process.env.RADIO_DIR || null;
const fileOf = id => path.join(radioDir(), String(id));

/** Ses dosyasının türü ilk baytlardan: MP3 (ID3 etiketi ya da çerçeve başı), OGG, M4A/AAC. */
function sniffAudio(head) {
    if (head.length < 12) return null;
    if (head.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    if (head.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
    if (head.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
    return null;
}

/** Başlık ve sanatçı: boşluklar sadeleşir, kontrol karakterleri atılır. */
function cleanText(value) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

const toClient = s => ({
    id: String(s._id), title: s.title, artist: s.artist, size: s.size, contentType: s.contentType, createdAt: s.createdAt,
});

async function usedBytes() {
    const [{ total = 0 } = {}] = await Song.aggregate([{ $group: { _id: null, total: { $sum: '$size' } } }]);
    return total;
}

// GET /radio/songs — şarkı listesi (en yeni önce) ve kullanılan alan
router.get('/songs', async (req, res) => {
    const songs = await Song.find().sort({ createdAt: -1 }).lean();
    res.json({ songs: songs.map(toClient), usedBytes: songs.reduce((n, s) => n + s.size, 0), capBytes: CAP_BYTES(), ready: !!radioDir() });
});

// GET /radio/songs/:id/file — ses dosyasının kendisi
router.get('/songs/:id/file', async (req, res) => {
    const song = mongoose.isValidObjectId(req.params.id) ? await Song.findById(req.params.id).lean() : null;
    if (!song || !radioDir()) return res.status(404).json({ error: 'Şarkı bulunamadı.' });
    const stream = fs.createReadStream(fileOf(song._id));
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'Şarkı dosyası bulunamadı.' }); else res.end(); });
    stream.on('open', () => {
        res.set('Content-Type', song.contentType);
        res.set('Content-Length', String(song.size));
        res.set('Cache-Control', 'private, max-age=31536000, immutable');
        stream.pipe(res);
    });
});

// POST /radio/songs?title=…&artist=… — gövde ses dosyasının kendisi (yalnızca admin)
router.post('/songs', requireAdmin, async (req, res) => {
    if (!radioDir()) return res.status(503).json({ error: 'Sunucuda şarkı klasörü ayarlı değil (RADIO_DIR).' });
    const title = cleanText(req.query.title);
    const artist = cleanText(req.query.artist);
    if (!title) return res.status(400).json({ error: 'Şarkının adı gerekli.' });
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_FILE) return res.status(413).json({ error: 'Şarkı en fazla 30 MB olabilir.' });
    if ((await usedBytes()) + declared > CAP_BYTES())
        return res.status(413).json({ error: 'vulu Radyo için ayrılan alan doldu; önce eski şarkılardan sil.' });

    const id = new mongoose.Types.ObjectId();
    const target = fileOf(id), part = target + '.part';
    try { fs.mkdirSync(radioDir(), { recursive: true }); }
    catch { return res.status(500).json({ error: 'Şarkı klasörü oluşturulamadı.' }); }
    const out = fs.createWriteStream(part, { flags: 'wx' });

    let size = 0, head = Buffer.alloc(0), contentType = null, finished = false;
    const fail = (status, error) => {
        if (finished) return;
        finished = true;
        req.unpipe(out);
        out.destroy();
        fs.unlink(part, () => { });
        res.status(status).json({ error });
    };

    req.on('data', chunk => {
        if (finished) return;
        size += chunk.length;
        if (size > MAX_FILE) return fail(413, 'Şarkı en fazla 30 MB olabilir.');
        if (!contentType && head.length < 12) {
            head = Buffer.concat([head, chunk]).subarray(0, 12);
            if (head.length >= 12 && !(contentType = sniffAudio(head)))
                fail(415, 'Yalnızca MP3, OGG ya da M4A ses dosyası yüklenebilir.');
        }
    });
    req.on('aborted', () => fail(400, 'Yükleme yarıda kaldı.'));
    out.on('error', () => fail(500, 'Şarkı kaydedilemedi.'));
    out.on('finish', async () => {
        if (finished) return;
        if (!contentType) return fail(415, 'Yalnızca MP3, OGG ya da M4A ses dosyası yüklenebilir.');
        finished = true;
        try {
            fs.renameSync(part, target);
            const song = await Song.create({ _id: id, title, artist, contentType, size, uploadedBy: req.user.username });
            res.status(201).json(toClient(song.toObject()));
        } catch {
            fs.unlink(part, () => { });
            fs.unlink(target, () => { });
            res.status(500).json({ error: 'Şarkı kaydedilemedi.' });
        }
    });
    req.pipe(out);
});

// PATCH /radio/songs/:id { title, artist } — yalnızca admin
router.patch('/songs/:id', requireAdmin, async (req, res) => {
    const song = mongoose.isValidObjectId(req.params.id) ? await Song.findById(req.params.id) : null;
    if (!song) return res.status(404).json({ error: 'Şarkı bulunamadı.' });
    if (req.body.title !== undefined) {
        const title = cleanText(req.body.title);
        if (!title) return res.status(400).json({ error: 'Şarkının adı boş olamaz.' });
        song.title = title;
    }
    if (req.body.artist !== undefined) song.artist = cleanText(req.body.artist);
    await song.save();
    res.json(toClient(song.toObject()));
});

// DELETE /radio/songs/:id — yalnızca admin
router.delete('/songs/:id', requireAdmin, async (req, res) => {
    const song = mongoose.isValidObjectId(req.params.id) ? await Song.findById(req.params.id).lean() : null;
    if (!song) return res.status(404).json({ error: 'Şarkı bulunamadı.' });
    await Song.deleteOne({ _id: song._id });
    if (radioDir()) fs.unlink(fileOf(song._id), () => { /* dosya zaten yoksa sorun değil */ });
    res.json({ deleted: true });
});

module.exports = router;
module.exports.sniffAudio = sniffAudio;
