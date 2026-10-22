const express = require('express');
const User = require('../models/User');
const Pack = require('../models/Pack');
const Shot = require('../models/Shot');
const Presence = require('../models/Presence');
const { downloadCounts } = require('./download');

/**
 * GET /stats — herkese açık sayılar (web sitesinin ana sayfası için). Yalnızca sayı döner;
 * kimin çevrimiçi olduğu, paket adları gibi bilgiler giriş gerektiren uç noktalarda kalır.
 * Sonuç 30 sn bellekte tutulur, böylece sayfa yenilemeleri veritabanını yormaz.
 */
const router = express.Router();

const CACHE_MS = 30 * 1000;
const PRESENCE_TTL = 2 * 60 * 1000;   // users.js ile aynı: 2 dakika ses gelmeyen çevrimdışı
let cached = null;

async function compute() {
    const since = new Date(Date.now() - PRESENCE_TTL);
    const [members, packs, shots, online, playing, downloads] = await Promise.all([
        User.countDocuments({ isActive: { $ne: false } }),
        Pack.estimatedDocumentCount(),
        Shot.estimatedDocumentCount(),
        Presence.countDocuments({ at: { $gt: since } }),
        Presence.countDocuments({ at: { $gt: since }, state: 'playing' }),
        downloadCounts(),
    ]);
    return { members, packs, shots, online, playing, downloads, at: new Date() };
}

router.get('/', async (req, res) => {
    if (!cached || Date.now() - cached.time > CACHE_MS) cached = { time: Date.now(), data: await compute() };
    res.set('Cache-Control', 'public, max-age=30');
    res.json(cached.data);
});

module.exports = router;
