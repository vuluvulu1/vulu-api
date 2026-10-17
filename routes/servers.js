const express = require('express');
const mongoose = require('mongoose');
const Server = require('../models/Server');
const Pack = require('../models/Pack');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const HOST = /^(?=.{1,120}$)[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?(?::(\d{1,5}))?$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const MAX_SERVERS = 50;

const toClient = s => ({
    id: String(s._id), name: s.name, address: s.address, description: s.description || '',
    packId: s.packId || null, mcVersion: s.mcVersion || '', order: s.order || 0,
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

// GET /servers
router.get('/', requireAuth, async (req, res) => {
    const servers = await Server.find().sort({ order: 1, createdAt: 1 }).lean();
    res.json(servers.map(toClient));
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
