const express = require('express');
const User = require('../models/User');
const progress = require('../lib/progress');
const capes = require('../lib/capes');
const { baseUrlOf } = require('../lib/yggdrasil');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// Liderlik tablosu, seviye/sezon ve vulu Pelerinleri. Tablo ve pelerin kataloğu herkese açık (web sitesi gösterir).
const router = express.Router();

let cache = new Map();   // dönem → { at, data }: tablo 5 dakikada bir değişir; site çok istek atsa da veritabanı yorulmaz

// GET /progress/leaderboard?period=week|season|all
router.get('/leaderboard', async (req, res) => {
    const period = ['week', 'season', 'all'].includes(req.query.period) ? req.query.period : 'week';
    const hit = cache.get(period);
    let data = hit && Date.now() - hit.at < 60 * 1000 ? hit.data : null;
    if (!data) {
        data = await progress.leaderboard(period);
        const names = [...new Set(data.categories.flatMap(c => c.rows.map(r => r.username)))];
        const users = await User.find({ username: { $in: names } }).select('username avatarVersion capeKey').lean();
        const info = new Map(users.map(u => [u.username, u]));
        for (const c of data.categories) for (const r of c.rows) {
            r.avatarVersion = info.get(r.username)?.avatarVersion || 0;
            r.cape = info.get(r.username)?.capeKey || '';
        }
        cache.set(period, { at: Date.now(), data });
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json(data);
});

// GET /progress/capes — pelerin kataloğu
router.get('/capes', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(capes.catalog(baseUrlOf(req)));
});

// GET /progress/seasons — sezonlar ve görevleri
router.get('/seasons', async (req, res) => {
    const now = new Date();
    const config = await progress.settings.load();
    res.json(config.seasons.map(s => ({
        key: s.key, name: s.name, startsAt: s.startsAt, endsAt: s.endsAt, cape: s.cape, capeLevel: s.capeLevel,
        current: new Date(s.startsAt) <= now && now < new Date(s.endsAt),
        quests: s.quests.map(q => ({ key: q.key, name: q.name, desc: q.desc, icon: q.icon, stat: q.stat, target: q.target })),
    })));
});

// GET /progress/admin/config — admin: sezonlar, görevler, seviye/XP ve haftalık dallar (düzenleme ekranı için)
router.get('/admin/config', requireAuth, requireAdmin, async (req, res) => {
    const config = await progress.settings.load(true);
    res.json({
        config: { ...config, badgeArchive: undefined },
        stats: Object.entries(progress.settings.STATS).map(([key, s]) => ({ key, label: s.label, unit: s.unit })),
        capes: capes.CATALOG.map(c => ({ key: c.key, name: c.name })),
    });
});

// PUT /progress/admin/config { config } — admin: kaydeder (hatalıysa 400 ve açıklama)
router.put('/admin/config', requireAuth, requireAdmin, async (req, res) => {
    const config = await progress.settings.save(req.body && req.body.config, req.user.username);
    cache = new Map();
    res.json({ config: { ...config, badgeArchive: undefined } });
});

/** Kullanıcının ilerlemesi + pelerinleri + rozetleri. */
async function full(user, baseUrl) {
    const p = await progress.progressOf(user.username);
    const owned = new Set((user.capes || []).map(c => c.key));
    return {
        ...p,
        capeKey: user.capeKey || '',
        capes: capes.catalog(baseUrl).map(c => ({ ...c, owned: owned.has(c.key), earnedAt: (user.capes || []).find(x => x.key === c.key)?.earnedAt || null })),
        badges: (user.badges || []).map(progress.badgeInfo),
    };
}

// GET /progress/me
router.get('/me', requireAuth, async (req, res) => res.json(await full(req.user, baseUrlOf(req))));

// GET /progress/user/:username — başkasının seviyesi, sezonu ve rozetleri (profil)
router.get('/user/:username', requireAuth, async (req, res) => {
    const user = await User.findOne({ username: String(req.params.username), isActive: true }).select('username capes capeKey badges').lean();
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const data = await full(user, baseUrlOf(req));
    data.capes = data.capes.filter(c => c.owned);
    res.json(data);
});

// PUT /progress/me/cape { key } — kazanılmış bir pelerini tak ('' = çıkar)
router.put('/me/cape', requireAuth, async (req, res) => {
    const key = typeof req.body?.key === 'string' ? req.body.key : '';
    if (key && !(req.user.capes || []).some(c => c.key === key)) return res.status(403).json({ error: 'Bu pelerini henüz kazanmadın.' });
    await User.updateOne({ _id: req.user._id }, { $set: { capeKey: key } });
    req.user.capeKey = key;
    res.json(await full(req.user, baseUrlOf(req)));
});

// POST /progress/capes/grant { username, key, note } — admin pelerin verir (Kurucu, Etkinlik birincisi…)
router.post('/capes/grant', requireAuth, requireAdmin, async (req, res) => {
    const { username, key, note } = req.body || {};
    if (typeof username !== 'string' || !(await User.exists({ username }))) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    if (!capes.exists(key)) return res.status(400).json({ error: 'Böyle bir pelerin yok.' });
    const added = await capes.grant(User, username, key, note || `${req.user.username} verdi`);
    cache = new Map();
    res.json({ success: true, added });
});

// DELETE /progress/capes/grant { username, key }
router.delete('/capes/grant', requireAuth, requireAdmin, async (req, res) => {
    const { username, key } = req.body || {};
    if (typeof username !== 'string' || typeof key !== 'string') return res.status(400).json({ error: 'Kullanıcı ve pelerin gerekli.' });
    await capes.revoke(User, username, key);
    cache = new Map();
    res.json({ success: true });
});

module.exports = router;
