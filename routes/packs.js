const express = require('express');
const mongoose = require('mongoose');
const Pack = require('../models/Pack');
const Feedback = require('../models/Feedback');
const Role = require('../models/Role');
const { canSeePack, visiblePacksQuery } = require('../lib/access');
const { requireAuth, requireAdmin, requirePackReader } = require('../middleware/auth');
const { squareLogo } = require('../lib/squareLogo');

const router = express.Router();

const BUCKET = 'packfiles';
const LIMITS = { overrides: 200 * 1024 * 1024, cover: 8 * 1024 * 1024, logo: 4 * 1024 * 1024 };
const LIMIT_ERRORS = { overrides: 'Paket dosyaları 200 MB\'ı aşıyor.', cover: 'Kapak 8 MB\'tan büyük olamaz.', logo: 'Logo 4 MB\'tan büyük olamaz.' };
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const COVER_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const CHANGELOG_KEEP = 30;
// Paketteki modların indirilebileceği yerler: Modrinth ve CurseForge'un kendi dağıtım sunucuları
const MOD_HOSTS = ['https://cdn.modrinth.com/', 'https://edge.forgecdn.net/', 'https://mediafilez.forgecdn.net/'];
const MAX_CHANGE_LIST = 200;   // tek revizyonda listelenen en fazla ekleme/çıkarma

/** İki mod listesinin farkı: proje (yoksa dosya) kimliğine göre eşleştirilir. */
function diffMods(oldMods, newMods) {
    const key = m => m.projectId || m.file || m.title;
    const label = m => m.title || m.file || m.projectId || '?';
    const before = new Map((oldMods || []).map(m => [key(m), m]));
    const after = new Map((newMods || []).map(m => [key(m), m]));
    const added = [], removed = [], updated = [];
    for (const [k, m] of after) {
        const old = before.get(k);
        if (!old) added.push(label(m));
        else if ((old.versionId || old.versionNumber) !== (m.versionId || m.versionNumber))
            updated.push({ title: label(m), from: String(old.versionNumber || ''), to: String(m.versionNumber || '') });
    }
    for (const [k, m] of before) if (!after.has(k)) removed.push(label(m));
    const sort = a => a.sort((x, y) => String(x.title || x).localeCompare(String(y.title || y), 'tr'));
    return { added: sort(added).slice(0, MAX_CHANGE_LIST), removed: sort(removed).slice(0, MAX_CHANGE_LIST), updated: sort(updated).slice(0, MAX_CHANGE_LIST) };
}

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
const fileCollection = () => mongoose.connection.db.collection(`${BUCKET}.files`);

/** Paketin istemciye gönderilen hali. Hangi rollere açık olduğunu yalnızca adminler görür. */
function toClient(pack, user) {
    return {
        ...(user && user.isAdmin ? { roles: (pack.roles || []).map(String) } : {}),
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
        changelog: (pack.changelog || []).map(c => ({
            revision: c.revision, at: c.at, by: c.by, note: c.note || '',
            added: c.added || [], removed: c.removed || [], updated: c.updated || [], filesChanged: !!c.filesChanged,
        })),
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

// GET /packs — kullanıcının rolleriyle görebildiği paketler
router.get('/', requirePackReader, async (req, res) => {
    const packs = await Pack.find(visiblePacksQuery(req.user)).sort({ updatedAt: -1 }).lean();
    res.json(packs.map(p => toClient(p, req.user)));
});

// GET /packs/:id — görme yetkisi olmayana paket yokmuş gibi davranılır
router.get('/:id', requirePackReader, async (req, res) => {
    const pack = await findPack(req.params.id);
    if (!pack || !canSeePack(req.user, pack)) return res.status(404).json({ error: 'Paket bulunamadı.' });
    res.json(toClient(pack, req.user));
});

// GET /packs/:id/overrides — seçilen klasörlerin zip'i
router.get('/:id/overrides', requirePackReader, async (req, res) => {
    const pack = await findPack(req.params.id);
    if (!pack || !canSeePack(req.user, pack)) return res.status(404).json({ error: 'Paket bulunamadı.' });
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

// GET /packs/:id/logo/square?v=<revision> — logo şeffaf kare zeminin ortasında (Discord durumu için).
// Sonuç dosya kimliğine göre bellekte tutulur; logo PNG değilse olduğu gibi döner.
const squareCache = new Map();
const SQUARE_CACHE_MAX = 50;
router.get('/:id/logo/square', async (req, res) => {
    const pack = await findPack(req.params.id);
    if (!pack || !pack.logoFileId) return res.status(404).end();
    const key = String(pack.logoFileId);
    let out = squareCache.get(key);
    if (!out) {
        const chunks = [];
        try {
            await new Promise((resolve, reject) => bucket().openDownloadStream(pack.logoFileId)
                .on('data', c => chunks.push(c)).on('error', reject).on('end', resolve));
        } catch { return res.status(404).end(); }
        const original = Buffer.concat(chunks);
        out = (pack.logoExt === '.png' && squareLogo(original)) || { original, type: IMAGE_TYPES[pack.logoExt] || 'image/png' };
        if (squareCache.size >= SQUARE_CACHE_MAX) squareCache.delete(squareCache.keys().next().value);
        squareCache.set(key, out);
    }
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    if (Buffer.isBuffer(out)) res.type('image/png').send(out);
    else res.type(out.type).send(out.original);
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
    const note = typeof body.changeNote === 'string' ? body.changeNote.trim() : '';
    if (note.length > 1000) return res.status(400).json({ error: 'Güncelleme notu en fazla 1000 karakter olabilir.' });
    if (!body.mcVersion || !LOADERS.includes(body.loader)) return res.status(400).json({ error: 'Sürüm bilgisi eksik.' });
    // Sürümler kurulan dosya ve klasör adlarına dönüşür; yalnızca sürüm karakterlerine izin verilir
    if (!VERSION.test(String(body.mcVersion)) || (body.loader !== 'vanilla' && !VERSION.test(String(body.loaderVersion || ''))))
        return res.status(400).json({ error: 'Sürüm bilgisi geçersiz.' });
    if (!Array.isArray(body.mods) || body.mods.length > 2000) return res.status(400).json({ error: 'Mod listesi geçersiz.' });
    if (body.mods.some(m => !m || typeof m.url !== 'string' || !MOD_HOSTS.some(h => m.url.startsWith(h))))
        return res.status(400).json({ error: 'Modlar yalnızca CurseForge ya da Modrinth adreslerinden indirilebilir.' });

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

    // Kimler erişebilir: rol kimlikleri; boş liste herkese açık demek. Verilmezse güncellemede eskisi kalır.
    let roles;
    if (body.roles !== undefined) {
        if (!Array.isArray(body.roles) || body.roles.length > 50 || body.roles.some(r => !mongoose.isValidObjectId(r)))
            return res.status(400).json({ error: 'Rol listesi geçersiz.' });
        roles = [...new Set(body.roles.map(String))];
        if (await Role.countDocuments({ _id: { $in: roles } }) !== roles.length)
            return res.status(400).json({ error: 'Seçilen rollerden biri artık yok; listeyi yenileyip tekrar dene.' });
    }

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
    if (roles) fields.roles = roles;

    if (body.id) {
        const pack = await findPack(body.id);
        if (!pack) return res.status(404).json({ error: 'Güncellenecek paket bulunamadı.' });

        const oldOverrides = pack.overridesFileId;
        const oldCover = cover ? pack.coverFileId : null;
        const oldLogo = logo || clearLogo ? pack.logoFileId : null;
        const change = {
            revision: pack.revision + 1, at: new Date(), by: req.user.username, note,
            ...diffMods(pack.mods, fields.mods),
            filesChanged: pack.overridesSize !== fields.overridesSize,
        };
        const changelog = [...(pack.changelog || []), change].slice(-CHANGELOG_KEEP);
        Object.assign(pack, fields, { revision: pack.revision + 1, changelog });
        await pack.save();

        await deleteFile(oldOverrides);
        await deleteFile(oldCover);
        await deleteFile(oldLogo);
        return res.json(toClient(pack, req.user));
    }

    const pack = await Pack.create({ ...fields, changelog: [{ revision: 1, at: new Date(), by: req.user.username, note, added: [], removed: [], updated: [] }] });
    res.json(toClient(pack, req.user));
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
