const express = require('express');
const mongoose = require('mongoose');
const Server = require('../models/Server');
const Pack = require('../models/Pack');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { visiblePacksQuery } = require('../lib/access');
const { createCounter } = require('../middleware/rateLimit');
const mcchat = require('../lib/mcchat');

const router = express.Router();
const HOST = /^(?=.{1,120}$)[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?(?::(\d{1,5}))?$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const MAX_SERVERS = 50;

const toClient = s => ({
    id: String(s._id), name: s.name, address: s.address, description: s.description || '',
    packId: s.packId || null, mcVersion: s.mcVersion || '', order: s.order || 0,
    chat: mcchat.servesAddress(s.address),
});

// Launcher'dan oyuna mesaj: kişi başına saniyede bir, dakikada 20
const chatFast = createCounter({ windowMs: 1000, max: 1 });
const chatMinute = createCounter({ windowMs: 60 * 1000, max: 20 });

/** Sohbeti olan ve bu kullanıcının görebildiği sunucu (paketi rolle kısıtlıysa o paketi görebilmeli). */
async function chatServer(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Sunucu bulunamadı.' }); return null; }
    const server = await Server.findById(req.params.id).lean();
    if (!server || !mcchat.servesAddress(server.address)) { res.status(404).json({ error: 'Bu sunucunun sohbeti yok.' }); return null; }
    if (server.packId && !req.user.isAdmin && !(await Pack.exists({ _id: server.packId, ...visiblePacksQuery(req.user) }))) {
        res.status(404).json({ error: 'Sunucu bulunamadı.' }); return null;
    }
    return server;
}

// GET /servers/:id/chat?after=<seq> — oyun içi sohbet (son 50, ya da after'dan sonrakiler)
router.get('/:id/chat', requireAuth, async (req, res) => {
    if (!await chatServer(req, res)) return;
    res.json(mcchat.since(req.query.after));
});

// POST /servers/:id/chat { text } — oyunda herkese "[Launcher] ad: mesaj"
router.post('/:id/chat', requireAuth, async (req, res) => {
    if (!await chatServer(req, res)) return;
    if (chatFast.hit(req.user.username) || chatMinute.hit(req.user.username))
        return res.status(429).json({ error: 'Çok hızlı yazıyorsun, biraz bekle.' });
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim() || text.length > 200) return res.status(400).json({ error: 'Mesaj 1-200 karakter olmalı.' });
    try { res.status(201).json(await mcchat.send(req.user.username, text)); }
    catch (err) { res.status(503).json({ error: err.message }); }
});

async function clean(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const address = typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const packId = typeof body.packId === 'string' && body.packId ? body.packId : null;
    const mcVersion = typeof body.mcVersion === 'string' ? body.mcVersion.trim() : '';
    if (!name || name.length > 40) return { error: 'Sunucu adı 1-40 karakter olmalı.' };
    const m = HOST.exec(address);
    if (!m || (m[1] && (+m[1] < 1 || +m[1] > 65535))) return { error: 'Adres geçersiz (ör. oyun.alanadi.com ya da 1.2.3.4:25565).' };
    if (description.length > 200) return { error: 'Açıklama en fazla 200 karakter olabilir.' };
    if (packId && (!mongoose.isValidObjectId(packId) || !(await Pack.exists({ _id: packId })))) return { error: 'Seçilen paket bulunamadı.' };
    if (!packId && mcVersion && !VERSION.test(mcVersion)) return { error: 'Minecraft sürümü geçersiz.' };
    return { value: { name, address, description, packId, mcVersion: packId ? '' : mcVersion } };
}

// GET /servers — paketi rolle kısıtlı sunucular yalnızca o paketi görebilenlere listelenir
router.get('/', requireAuth, async (req, res) => {
    const [servers, visible] = await Promise.all([
        Server.find().sort({ order: 1, createdAt: 1 }).lean(),
        Pack.find(visiblePacksQuery(req.user)).select('_id').lean(),
    ]);
    const packs = new Set(visible.map(p => String(p._id)));
    res.json(servers.filter(s => !s.packId || req.user.isAdmin || packs.has(String(s.packId))).map(toClient));
});

// POST /servers (admin)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
    if (await Server.countDocuments() >= MAX_SERVERS) return res.status(400).json({ error: `En fazla ${MAX_SERVERS} sunucu eklenebilir.` });
    const { value, error } = await clean(req.body || {});
    if (error) return res.status(400).json({ error });
    const server = await Server.create({ ...value, order: await Server.countDocuments(), createdBy: req.user.username });
    res.status(201).json(toClient(server));
});

// PUT /servers/:id (admin)
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    const { value, error } = await clean(req.body || {});
    if (error) return res.status(400).json({ error });
    const server = await Server.findByIdAndUpdate(req.params.id, { $set: value }, { returnDocument: 'after' });
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    res.json(toClient(server));
});

// DELETE /servers/:id (admin)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    const result = await Server.deleteOne({ _id: req.params.id });
    if (!result.deletedCount) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    res.json({ success: true });
});

module.exports = router;
