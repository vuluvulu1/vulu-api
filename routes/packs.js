const express = require('express');
const mongoose = require('mongoose');
const Pack = require('../models/Pack');
const Feedback = require('../models/Feedback');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const BUCKET = 'packfiles';
const LIMITS = { overrides: 200 * 1024 * 1024, cover: 8 * 1024 * 1024, logo: 4 * 1024 * 1024 };
const LIMIT_ERRORS = { overrides: 'Paket dosyaları 200 MB\'ı aşıyor.', cover: 'Kapak 8 MB\'tan büyük olamaz.', logo: 'Logo 4 MB\'tan büyük olamaz.' };
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const COVER_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
const fileCollection = () => mongoose.connection.db.collection(`${BUCKET}.files`);

function toClient(pack) {
    return {
        id: String(pack._id),
        name: pack.name,
        description: pack.description || '',
        author: pack.author,
        mcVersion: pack.mcVersion,
        loader: pack.loader,
        loaderVersion: pack.loaderVersion || null,
        recommendedRamGb: pack.recommendedRamGb || 8,
        revision: pack.revision,
        createdAt: pack.createdAt,
        updatedAt: pack.updatedAt,
        mods: pack.mods || [],
        includes: pack.includes || [],
        overridesSize: pack.overridesSize || 0,
        hasCover: !!pack.coverFileId,
        coverExt: pack.coverExt || null,
        hasLogo: !!pack.logoFileId,
        logoExt: pack.logoExt || null,
    };
}

async function findPack(id) {
    if (!mongoose.isValidObjectId(id)) return null;
    return Pack.findById(id);
}

async function deleteFile(id) {
    if (!id) return;
    try { await bucket().delete(new mongoose.Types.ObjectId(String(id))); }
    catch { /* zaten silinmiş */ }
}

function streamFile(res, fileId, contentType, cacheable) {
    res.set('Content-Type', contentType);
    if (cacheable) res.set('Cache-Control', 'public, max-age=604800, immutable');
    bucket().openDownloadStream(fileId)
        .on('error', () => { if (!res.headersSent) res.status(404); res.end(); })
        .pipe(res);
}

// GET /packs
router.get('/', requireAuth, async (req, res) => {
    const packs = await Pack.find().sort({ updatedAt: -1 }).lean();
    res.json(packs.map(toClient));
});

// GET /packs/:id
router.get('/:id', requireAuth, async (req, res) => {
    const pack = await findPack(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Paket bulunamadı.' });
    res.json(toClient(pack));
});

// GET /packs/:id/overrides — seçilen klasörlerin zip'i
router.get('/:id/overrides', requireAuth, async (req, res) => {
    const pack = await findPack(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Paket bulunamadı.' });
    res.set('Content-Length', String(pack.overridesSize || ''));
    streamFile(res, pack.overridesFileId, 'application/zip', false);
});

// GET /packs/:id/cover?v=<revision> — <img> doğrudan yüklesin diye herkese açık
router.get('/:id/cover', async (req, res) => {
    const pack = await findPack(req.params.id);
    if (!pack || !pack.coverFileId) return res.status(404).end();
    streamFile(res, pack.coverFileId, IMAGE_TYPES[pack.coverExt] || 'image/png', true);
});

// GET /packs/:id/logo?v=<revision>
router.get('/:id/logo', async (req, res) => {
    const pack = await findPack(req.params.id);
    if (!pack || !pack.logoFileId) return res.status(404).end();
    streamFile(res, pack.logoFileId, IMAGE_TYPES[pack.logoExt] || 'image/png', true);
});

/**
 * POST /packs/files?kind=overrides|cover|logo  (admin)
 * Gövde dosyanın kendisidir; belleğe alınmadan doğrudan GridFS'e akıtılır.
 * Dönen fileId, POST /packs ile paket yayınlanırken kullanılır.
 */
router.post('/files', requireAuth, requireAdmin, (req, res) => {
    const kind = req.query.kind;
    if (!LIMITS[kind]) return res.status(400).json({ error: 'Geçersiz dosya türü.' });

    const limit = LIMITS[kind];
    if (Number(req.headers['content-length'] || 0) > limit)
        return res.status(413).json({ error: LIMIT_ERRORS[kind] });

    const upload = bucket().openUploadStream(`${kind}-${Date.now()}`, {
        metadata: { kind, uploadedBy: req.user.username },
    });

    let size = 0, finished = false;
    const fail = (status, error) => {
        if (finished) return;
        finished = true;
        req.unpipe(upload);
        upload.abort().catch(() => { });
        res.status(status).json({ error });
    };

    req.on('data', chunk => {
        size += chunk.length;
        if (size > limit) fail(413, 'Dosya boyut sınırını aşıyor.');
    });
    req.on('aborted', () => fail(400, 'Yükleme yarıda kaldı.'));
    upload.on('error', () => fail(500, 'Dosya kaydedilemedi.'));
    upload.on('finish', () => {
        if (finished) return;
        finished = true;
        res.json({ fileId: String(upload.id), size });
    });

    req.pipe(upload);
});

/** Yüklenen dosya gerçekten bu admin tarafından bu amaçla yüklenmiş mi? */
async function ownedUpload(id, kind, username) {
    if (!mongoose.isValidObjectId(id)) return null;
    return fileCollection().findOne({
        _id: new mongoose.Types.ObjectId(String(id)),
        'metadata.kind': kind,
        'metadata.uploadedBy': username,
    });
}

/**
 * POST /packs  (admin) — yeni paket ya da (id verilirse) yeni revizyon.
 * Dosyalar önce /packs/files ile yüklenmiş olmalı.
 */
router.post('/', requireAuth, requireAdmin, async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const description = String(body.description || '').trim();

    if (name.length < 1 || name.length > 40) return res.status(400).json({ error: 'Paket adı 1-40 karakter olmalı.' });
    if (description.length > 600) return res.status(400).json({ error: 'Açıklama en fazla 600 karakter olabilir.' });
    if (!body.mcVersion || !LOADERS.includes(body.loader)) return res.status(400).json({ error: 'Sürüm bilgisi eksik.' });
    if (!Array.isArray(body.mods) || body.mods.length > 2000) return res.status(400).json({ error: 'Mod listesi geçersiz.' });
    if (body.mods.some(m => !m || typeof m.url !== 'string' || !m.url.startsWith('https://cdn.modrinth.com/')))
        return res.status(400).json({ error: 'Modlar yalnızca Modrinth adreslerinden indirilebilir.' });

    const overrides = await ownedUpload(body.overridesFileId, 'overrides', req.user.username);
    if (!overrides) return res.status(400).json({ error: 'Paket dosyası bulunamadı, tekrar yükleyin.' });

    let cover = null;
    if (body.coverFileId) {
        cover = await ownedUpload(body.coverFileId, 'cover', req.user.username);
        if (!cover || !COVER_EXTS.includes(body.coverExt)) return res.status(400).json({ error: 'Kapak resmi geçersiz.' });
    }

    // Logo: yeni dosya verilirse değişir, clearLogo ile kaldırılır, ikisi de yoksa eskisi kalır
    let logo = null;
    if (body.logoFileId) {
        logo = await ownedUpload(body.logoFileId, 'logo', req.user.username);
        if (!logo || !COVER_EXTS.includes(body.logoExt)) return res.status(400).json({ error: 'Logo resmi geçersiz.' });
    }
    const clearLogo = !logo && body.clearLogo === true;

    const fields = {
        name, description,
        author: req.user.username,
        mcVersion: String(body.mcVersion),
        loader: body.loader,
        loaderVersion: body.loader === 'vanilla' ? null : String(body.loaderVersion || ''),
        recommendedRamGb: Math.min(32, Math.max(2, Number(body.recommendedRamGb) || 8)),
        mods: body.mods,
        includes: Array.isArray(body.includes) ? body.includes.map(String).slice(0, 100) : [],
        overridesFileId: overrides._id,
        overridesSize: overrides.length,
        updatedAt: new Date(),
    };
    if (cover) { fields.coverFileId = cover._id; fields.coverExt = body.coverExt; }
    if (logo) { fields.logoFileId = logo._id; fields.logoExt = body.logoExt; }
    if (clearLogo) { fields.logoFileId = null; fields.logoExt = null; }

    if (body.id) {
        const pack = await findPack(body.id);
        if (!pack) return res.status(404).json({ error: 'Güncellenecek paket bulunamadı.' });

        const oldOverrides = pack.overridesFileId;
        const oldCover = cover ? pack.coverFileId : null;
        const oldLogo = logo || clearLogo ? pack.logoFileId : null;
        Object.assign(pack, fields, { revision: pack.revision + 1 });
        await pack.save();

        await deleteFile(oldOverrides);
        await deleteFile(oldCover);
        await deleteFile(oldLogo);
        return res.json(toClient(pack));
    }

    const pack = await Pack.create(fields);
    res.json(toClient(pack));
});

// DELETE /packs/:id  (admin)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    const pack = await findPack(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Paket bulunamadı.' });
    await Pack.deleteOne({ _id: pack._id });
    await Feedback.deleteMany({ pack: pack._id });
    await deleteFile(pack.overridesFileId);
    await deleteFile(pack.coverFileId);
    await deleteFile(pack.logoFileId);
    res.json({ success: true });
});

module.exports = router;
