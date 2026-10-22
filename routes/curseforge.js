const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { createCounter } = require('../middleware/rateLimit');

/**
 * CurseForge vekili. CurseForge API anahtarı yalnızca sunucuda durur (CURSEFORGE_API_KEY); launcher CurseForge'a
 * bu yollar üzerinden ulaşır. Yalnızca Minecraft içeriği ve aşağıdaki uçlar geçer, yanıtlar kısa süre önbelleğe alınır.
 * Modu başka uygulamalardan indirilmeye kapatılmış yapımcıların dosyalarında CurseForge indirme adresi vermez;
 * vekil bunu değiştirmez, launcher kullanıcıyı CurseForge sitesine yönlendirir.
 */
const router = express.Router();
router.use(requireAuth);

const GAME_ID = 432;                                   // Minecraft
const CLASS_IDS = new Set([6, 12, 4471, 6552]);        // mod, kaynak paketi, modpack, shader
const LOADER_TYPES = new Set([1, 4, 5, 6]);            // Forge, Fabric, Quilt, NeoForge
const SORT_FIELDS = new Set([1, 2, 3, 4, 6, 11, 12]);  // öne çıkan, popüler, güncel, ad, indirme, yeni, puan
const VERSION = /^[0-9]+(\.[0-9]+){1,2}$/;
const MAX_IDS = 1000;
const TTL = { short: 5 * 60 * 1000, long: 24 * 60 * 60 * 1000 };
const MAX_CACHE = 2000;

const base = () => (process.env.CURSEFORGE_API_BASE || 'https://api.curseforge.com').replace(/\/$/, '');
const limit = createCounter({ windowMs: 60 * 1000, max: 120 });
const cache = new Map();   // anahtar → { at, ttl, status, body }

router.use((req, res, next) => {
    if (!process.env.CURSEFORGE_API_KEY) return res.status(503).json({ error: 'CurseForge henüz ayarlanmadı.' });
    if (limit.hit(req.user.username)) return res.status(429).json({ error: 'Çok fazla CurseForge isteği. Biraz bekleyip tekrar dene.' });
    next();
});

/** CurseForge'a istek; aynı istek kısa süre içinde tekrar gelirse önbellekten döner. */
async function forward(res, path, { method = 'GET', body, ttl = TTL.short } = {}) {
    const key = method + ' ' + path + (body ? ' ' + JSON.stringify(body) : '');
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return res.status(hit.status).type('application/json').send(hit.body);

    let upstream;
    try {
        upstream = await fetch(base() + path, {
            method,
            headers: { 'x-api-key': process.env.CURSEFORGE_API_KEY, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
    } catch {
        return res.status(502).json({ error: 'CurseForge\'a ulaşılamadı.' });
    }
    const text = await upstream.text();
    if (upstream.status === 403 || upstream.status === 401) {
        console.error('CurseForge anahtarı reddedildi:', upstream.status);
        return res.status(502).json({ error: 'CurseForge isteği reddetti.' });
    }
    if (upstream.status === 404) return res.status(404).json({ error: 'CurseForge\'da bulunamadı.' });
    if (!upstream.ok) return res.status(502).json({ error: `CurseForge hata verdi (${upstream.status}).` });

    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), ttl, status: 200, body: text });
    res.status(200).type('application/json').send(text);
}

const int = v => (typeof v === 'string' && /^[0-9]{1,10}$/.test(v) ? Number(v) : Number.isInteger(v) && v > 0 ? v : null);
const idList = v => (Array.isArray(v) && v.length > 0 && v.length <= MAX_IDS && v.every(x => Number.isInteger(x) && x > 0) ? v : null);

// GET /curseforge/search?classId=6&searchFilter=&gameVersion=&modLoaderType=&categoryIds=1,2&sortField=&index=&pageSize=
router.get('/search', (req, res) => {
    const q = req.query;
    const classId = int(q.classId);
    if (!CLASS_IDS.has(classId)) return res.status(400).json({ error: 'İçerik türü geçersiz.' });
    const params = new URLSearchParams({ gameId: GAME_ID, classId });
    if (typeof q.searchFilter === 'string' && q.searchFilter.trim()) params.set('searchFilter', q.searchFilter.trim().slice(0, 100));
    if (typeof q.gameVersion === 'string' && VERSION.test(q.gameVersion)) params.set('gameVersion', q.gameVersion);
    if (LOADER_TYPES.has(int(q.modLoaderType))) params.set('modLoaderType', int(q.modLoaderType));
    if (typeof q.categoryIds === 'string' && q.categoryIds) {
        const ids = q.categoryIds.split(',').map(int);
        if (ids.length > 10 || ids.some(i => !i)) return res.status(400).json({ error: 'Kategori geçersiz.' });
        params.set('categoryIds', JSON.stringify(ids));
    }
    if (SORT_FIELDS.has(int(q.sortField))) { params.set('sortField', int(q.sortField)); params.set('sortOrder', q.sortOrder === 'asc' ? 'asc' : 'desc'); }
    const pageSize = Math.min(50, Math.max(1, int(q.pageSize) || 20));
    const index = Math.min(10000 - pageSize, Math.max(0, int(q.index) || 0));   // CurseForge index + pageSize ≤ 10000 ister
    params.set('pageSize', pageSize);
    params.set('index', index);
    return forward(res, `/v1/mods/search?${params}`);
});

// GET /curseforge/categories?classId=6
router.get('/categories', (req, res) => {
    const classId = int(req.query.classId);
    if (!CLASS_IDS.has(classId)) return res.status(400).json({ error: 'İçerik türü geçersiz.' });
    return forward(res, `/v1/categories?gameId=${GAME_ID}&classId=${classId}`, { ttl: TTL.long });
});

// GET /curseforge/mods/:id
router.get('/mods/:id', (req, res) => {
    const id = int(req.params.id);
    if (!id) return res.status(404).json({ error: 'CurseForge\'da bulunamadı.' });
    return forward(res, `/v1/mods/${id}`);
});

// GET /curseforge/mods/:id/files?gameVersion=&modLoaderType=&index=&pageSize=
router.get('/mods/:id/files', (req, res) => {
    const id = int(req.params.id);
    if (!id) return res.status(404).json({ error: 'CurseForge\'da bulunamadı.' });
    const q = req.query;
    const params = new URLSearchParams();
    if (typeof q.gameVersion === 'string' && VERSION.test(q.gameVersion)) params.set('gameVersion', q.gameVersion);
    if (LOADER_TYPES.has(int(q.modLoaderType))) params.set('modLoaderType', int(q.modLoaderType));
    params.set('pageSize', Math.min(50, Math.max(1, int(q.pageSize) || 50)));
    params.set('index', Math.min(9950, Math.max(0, int(q.index) || 0)));
    return forward(res, `/v1/mods/${id}/files?${params}`);
});

// POST /curseforge/mods { modIds: [..] } — birden çok proje
router.post('/mods', (req, res) => {
    const modIds = idList(req.body?.modIds);
    if (!modIds) return res.status(400).json({ error: 'Proje listesi geçersiz.' });
    return forward(res, '/v1/mods', { method: 'POST', body: { modIds, filterPcOnly: true } });
});

// POST /curseforge/files { fileIds: [..] } — modpack dosyaları
router.post('/files', (req, res) => {
    const fileIds = idList(req.body?.fileIds);
    if (!fileIds) return res.status(400).json({ error: 'Dosya listesi geçersiz.' });
    return forward(res, '/v1/mods/files', { method: 'POST', body: { fileIds } });
});

// POST /curseforge/fingerprints { fingerprints: [..] } — elle eklenmiş jar'ları tanımak için
router.post('/fingerprints', (req, res) => {
    const fingerprints = Array.isArray(req.body?.fingerprints) && req.body.fingerprints.length > 0 && req.body.fingerprints.length <= MAX_IDS
        && req.body.fingerprints.every(x => Number.isInteger(x) && x >= 0 && x <= 0xffffffff) ? req.body.fingerprints : null;
    if (!fingerprints) return res.status(400).json({ error: 'Parmak izi listesi geçersiz.' });
    return forward(res, `/v1/fingerprints/${GAME_ID}`, { method: 'POST', body: { fingerprints } });
});

module.exports = router;
