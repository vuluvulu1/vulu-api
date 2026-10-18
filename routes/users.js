const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Avatar = require('../models/Avatar');
const Banner = require('../models/Banner');
const Pack = require('../models/Pack');
const crypto = require('crypto');
const Skin = require('../models/Skin');
const GameSession = require('../models/GameSession');
const PanelToken = require('../models/PanelToken');
const { offlineUuid, baseUrlOf } = require('../lib/yggdrasil');
const { tokenHash } = require('./yggdrasil');
const { requireAuth, requirePackReader, signToken, PANEL_PREFIX, panelTokenHash } = require('../middleware/auth');

const router = express.Router();

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const BANNER_MAX_BYTES = 1.5 * 1024 * 1024;   // launcher büyük resimleri yüklemeden önce küçültür
const MAX_BIO = 300;

// Şifre hash'i ve izinler asla dışarı verilmez
function publicProfile(user, packCount = 0) {
    return {
        username: user.username,
        bio: user.bio || '',
        isAdmin: !!user.isAdmin,
        avatarVersion: user.avatarVersion || 0,
        bannerVersion: user.bannerVersion || 0,
        playtime: user.playtime && user.playtime.totalSeconds > 0
            ? { totalSeconds: user.playtime.totalSeconds, top: (user.playtime.top || []).map(t => ({ name: t.name, seconds: t.seconds })) }
            : null,
        skinHash: user.skinHash || '',
        skinModel: user.skinModel === 'slim' ? 'slim' : 'default',
        createdAt: user.createdAt || null,
        lastSeenAt: user.lastSeenAt || null,
        packCount,
    };
}

/**
 * Yalnızca verilen alanları yazar. save() belgenin tamamını şemaya göre doğruladığı için eski
 * (launcher'ın admin panelinden oluşturulmuş) kayıtlarda reddedilebilir; $set buna takılmaz.
 */
async function setFields(user, fields) {
    await User.updateOne({ _id: user._id }, { $set: fields });
    user.set(fields);
}

async function packCounts() {
    const rows = await Pack.aggregate([{ $group: { _id: '$author', count: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map(r => [r._id, r.count]));
}

// GET /users — bütün aktif kullanıcılar
router.get('/', requireAuth, async (req, res) => {
    const [users, counts] = await Promise.all([
        User.find({ isActive: true }).sort({ lastSeenAt: -1, username: 1 }),
        packCounts(),
    ]);
    res.json(users.map(u => publicProfile(u, counts[u.username] || 0)));
});

// ── Çevrimiçi durum (arkadaş listesi) ────────────────────────────────
// Launcher 45 sn'de bir bildirir; bellekte tutulur (sunucu yeniden başlarsa ilk bildirimde geri gelir).
// 2 dakika ses gelmeyen çevrimdışı sayılır. Kullanıcı ayarlardan ayrıntıları gizleyebilir ya da hiç bildirmeyebilir.
const presence = new Map();          // username → { state, instance, mcVersion, loader, packId, server, since, at }
const PRESENCE_TTL = 2 * 60 * 1000;
const PRESENCE_STATES = ['launcher', 'playing', 'online'];
const short = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

// POST /users/me/presence { state, instance?, mcVersion?, loader?, packId?, server? }
router.post('/me/presence', requireAuth, async (req, res) => {
    const b = req.body || {};
    const state = PRESENCE_STATES.includes(b.state) ? b.state : 'online';
    const playing = state === 'playing';
    const prev = presence.get(req.user.username);
    const entry = {
        state,
        instance: playing ? short(b.instance, 60) : '',
        mcVersion: playing ? short(b.mcVersion, 40) : '',
        loader: playing ? short(b.loader, 20) : '',
        packId: playing && /^[0-9a-f]{24}$/.test(b.packId || '') ? b.packId : null,
        server: playing ? short(b.server, 120) : '',
        at: Date.now(),
    };
    // "since": bu duruma ne zaman geçildiği (aynı oyunda kaldıkça değişmez)
    entry.since = prev && prev.state === entry.state && prev.instance === entry.instance ? prev.since : Date.now();
    presence.set(req.user.username, entry);
    // Son görülme veritabanına en fazla 5 dakikada bir yazılır
    if (!req.user.lastSeenAt || Date.now() - new Date(req.user.lastSeenAt).getTime() > 5 * 60 * 1000)
        User.updateOne({ _id: req.user._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
    res.json({ ok: true });
});

// DELETE /users/me/presence — launcher kapanırken
router.delete('/me/presence', requireAuth, (req, res) => {
    presence.delete(req.user.username);
    res.json({ ok: true });
});

// GET /users/presence — çevrimiçi olanlar
router.get('/presence', requireAuth, (req, res) => {
    const now = Date.now();
    const online = [];
    for (const [username, p] of presence) {
        if (now - p.at > PRESENCE_TTL) { presence.delete(username); continue; }
        online.push({
            username, state: p.state, instance: p.instance, mcVersion: p.mcVersion, loader: p.loader,
            packId: p.packId, server: p.server, since: new Date(p.since).toISOString(),
        });
    }
    res.json(online);
});

// GET /users/me
router.get('/me', requireAuth, async (req, res) => {
    const counts = await packCounts();
    res.json(publicProfile(req.user, counts[req.user.username] || 0));
});

// PUT /users/me — açıklama
router.put('/me', requireAuth, async (req, res) => {
    const bio = String(req.body.bio ?? '').trim();
    if (bio.length > MAX_BIO) return res.status(400).json({ error: `Açıklama en fazla ${MAX_BIO} karakter olabilir.` });

    await setFields(req.user, { bio });
    res.json(publicProfile(req.user));
});

// PUT /users/me/avatar — gövde resmin kendisi (Content-Type: image/png vb.)
router.put('/me/avatar', requireAuth, express.raw({ type: AVATAR_TYPES, limit: '1mb' }), async (req, res) => {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!AVATAR_TYPES.includes(contentType) || !Buffer.isBuffer(req.body) || req.body.length === 0)
        return res.status(400).json({ error: 'Desteklenen biçimler: PNG, JPG, WEBP, GIF (en fazla 1 MB).' });

    await Avatar.findOneAndUpdate(
        { username: req.user.username },
        { data: req.body, contentType, updatedAt: new Date() },
        { upsert: true });

    await setFields(req.user, { avatarVersion: Date.now() });
    res.json(publicProfile(req.user));
});

// DELETE /users/me/avatar
router.delete('/me/avatar', requireAuth, async (req, res) => {
    await Avatar.deleteOne({ username: req.user.username });
    await setFields(req.user, { avatarVersion: 0 });
    res.json(publicProfile(req.user));
});

/** Gövdenin gerçekten beyan edilen türde bir resim olup olmadığı (ilk baytlarından). */
function looksLike(type, buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 16) return false;
    if (type === 'image/png') return buf.readUInt32BE(0) === 0x89504e47;
    if (type === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (type === 'image/gif') return buf.toString('ascii', 0, 4) === 'GIF8';
    if (type === 'image/webp') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    return false;
}

// PUT /users/me/banner — gövde resmin kendisi (Content-Type: image/png vb.)
router.put('/me/banner', requireAuth, express.raw({ type: AVATAR_TYPES, limit: BANNER_MAX_BYTES }), async (req, res) => {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!AVATAR_TYPES.includes(contentType) || !looksLike(contentType, req.body))
        return res.status(400).json({ error: 'Desteklenen biçimler: PNG, JPG, WEBP, GIF (en fazla 1,5 MB).' });

    await Banner.findOneAndUpdate(
        { username: req.user.username },
        { data: req.body, contentType, updatedAt: new Date() },
        { upsert: true });

    await setFields(req.user, { bannerVersion: Date.now() });
    res.json(publicProfile(req.user));
});

// DELETE /users/me/banner
router.delete('/me/banner', requireAuth, async (req, res) => {
    await Banner.deleteOne({ username: req.user.username });
    await setFields(req.user, { bannerVersion: 0 });
    res.json(publicProfile(req.user));
});

// PUT /users/me/playtime { totalSeconds, top: [{ name, seconds }] } — profilde görünen oynama istatistiği
router.put('/me/playtime', requireAuth, async (req, res) => {
    const b = req.body || {};
    const seconds = v => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 100 * 365 * 24 * 3600) : null);
    const total = seconds(b.totalSeconds);
    if (total === null || !Array.isArray(b.top) || b.top.length > 5) return res.status(400).json({ error: 'Oynama süresi geçersiz.' });
    const top = [];
    for (const t of b.top) {
        const name = typeof t?.name === 'string' ? t.name.trim().slice(0, 64) : '';
        const s = seconds(t?.seconds);
        if (!name || s === null) return res.status(400).json({ error: 'Oynama süresi geçersiz.' });
        top.push({ name, seconds: s });
    }
    await setFields(req.user, { playtime: { totalSeconds: total, top, updatedAt: new Date() } });
    res.json({ ok: true });
});

// DELETE /users/me/playtime — kullanıcı göstermek istemiyor
router.delete('/me/playtime', requireAuth, async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $unset: { playtime: '' } });
    res.json({ ok: true });
});

// ── Skin ──────────────────────────────────────────────────────────────
const SKIN_MAX_BYTES = 64 * 1024;

/** Minecraft skin'i mi: PNG ve 64×64 (ya da eski biçim 64×32). */
function skinSize(buffer) {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(png) || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Artık hiçbir kullanıcının kullanmadığı skin resmi silinir. */
async function dropUnusedSkin(hash) {
    if (hash && !(await User.exists({ skinHash: hash }))) await Skin.deleteOne({ hash });
}

// PUT /users/me/skin?model=default|slim — gövde PNG'nin kendisi
router.put('/me/skin', requireAuth, express.raw({ type: 'image/png', limit: SKIN_MAX_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        return res.status(400).json({ error: 'Skin PNG olmalı (en fazla 64 KB).' });
    const size = skinSize(req.body);
    if (!size || size.width !== 64 || (size.height !== 64 && size.height !== 32))
        return res.status(400).json({ error: 'Skin 64×64 (ya da eski biçim 64×32) piksel bir PNG olmalı.' });

    const hash = crypto.createHash('sha256').update(req.body).digest('hex');
    await Skin.updateOne({ hash }, { $setOnInsert: { hash, data: req.body } }, { upsert: true });

    const previous = req.user.skinHash;
    await setFields(req.user, { skinHash: hash, skinModel: req.query.model === 'slim' ? 'slim' : 'default' });
    if (previous && previous !== hash) await dropUnusedSkin(previous);
    res.json(publicProfile(req.user));
});

// PUT /users/me/skin/model { model } — yalnızca beden tipi (Klasik / İnce)
router.put('/me/skin/model', requireAuth, async (req, res) => {
    const model = req.body.model === 'slim' ? 'slim' : 'default';
    await setFields(req.user, { skinModel: model });
    res.json(publicProfile(req.user));
});

// DELETE /users/me/skin — varsayılan skine dönülür
router.delete('/me/skin', requireAuth, async (req, res) => {
    const previous = req.user.skinHash;
    await setFields(req.user, { skinHash: '', skinModel: 'default' });
    await dropUnusedSkin(previous);
    res.json(publicProfile(req.user));
});

// POST /users/me/game-session — launcher oyunu başlatırken alır; oyun LAN'a/sunucuya katılırken bununla doğrulanır
router.post('/me/game-session', requireAuth, async (req, res) => {
    const accessToken = crypto.randomBytes(32).toString('hex');
    const profileId = offlineUuid(req.user.username);
    await GameSession.create({ tokenHash: tokenHash(accessToken), username: req.user.username, profileId });
    res.json({ accessToken, profileId, name: req.user.username, apiRoot: `${baseUrlOf(req)}/yggdrasil` });
});

// POST /users/me/panel-token { label } — vulu Server Panel'i hesaba bağlar (yalnızca paketleri okuyabilir).
// Launcher oturumuyla alınır; panel token'ıyla yeni token alınamaz.
const MAX_PANEL_TOKENS = 10;
router.post('/me/panel-token', requireAuth, async (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 60) : '';
    const token = PANEL_PREFIX + crypto.randomBytes(32).toString('hex');
    await PanelToken.create({ tokenHash: panelTokenHash(token), username: req.user.username, tokenVersion: req.user.tokenVersion || 0, label });
    // Hesap başına en fazla 10 bağlı panel: en eskiler düşer
    const extra = await PanelToken.find({ username: req.user.username }).sort({ createdAt: -1 }).skip(MAX_PANEL_TOKENS).select('_id').lean();
    if (extra.length) await PanelToken.deleteMany({ _id: { $in: extra.map(t => t._id) } });
    res.json({ token, username: req.user.username });
});

// DELETE /users/me/panel-token — panel bağlantıyı kaldırırken kendi token'ını siler
router.delete('/me/panel-token', requirePackReader, async (req, res) => {
    if (req.panelToken) await PanelToken.deleteOne({ _id: req.panelToken._id });
    res.json({ success: true });
});

// POST /users/me/password
router.post('/me/password', requireAuth, async (req, res) => {
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    if (!currentPassword || !newPassword)
        return res.status(400).json({ error: 'Mevcut ve yeni şifre gerekli.' });
    if (String(newPassword).length < 6 || String(newPassword).length > 72)
        return res.status(400).json({ error: 'Yeni şifre 6-72 karakter olmalı.' });

    const valid = await bcrypt.compare(String(currentPassword), req.user.passwordHash);
    if (!valid) return res.status(400).json({ error: 'Mevcut şifre yanlış.' });

    // Bu hesabın diğer bütün oturumları kapanır; değiştiren kişiye yeni token verilir
    await setFields(req.user, {
        passwordHash: await bcrypt.hash(String(newPassword), 10),
        tokenVersion: (req.user.tokenVersion || 0) + 1,
    });
    await GameSession.deleteMany({ username: req.user.username });
    await PanelToken.deleteMany({ username: req.user.username });
    res.json({ success: true, token: signToken(req.user) });
});

// GET /users/:username — profil ve paylaştığı paketler
router.get('/:username', requireAuth, async (req, res) => {
    const user = await User.findOne({ username: req.params.username, isActive: true });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

    const packs = await Pack.find({ author: user.username }).sort({ updatedAt: -1 })
        .select('name revision updatedAt mcVersion loader coverFileId').lean();

    res.json({
        ...publicProfile(user, packs.length),
        packs: packs.map(p => ({
            id: String(p._id), name: p.name, revision: p.revision, updatedAt: p.updatedAt,
            mcVersion: p.mcVersion, loader: p.loader, hasCover: !!p.coverFileId,
        })),
    });
});

// GET /users/:username/avatar — <img> doğrudan yüklesin diye herkese açık; adres ?v=avatarVersion ile değişir
router.get('/:username/avatar', async (req, res) => {
    const avatar = await Avatar.findOne({ username: req.params.username });
    if (!avatar) return res.status(404).end();
    res.set('Content-Type', avatar.contentType);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(avatar.data);
});

// GET /users/:username/banner — avatar gibi herkese açık; adres ?v=bannerVersion ile değişir
router.get('/:username/banner', async (req, res) => {
    if (typeof req.params.username !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(req.params.username)) return res.status(404).end();
    const banner = await Banner.findOne({ username: req.params.username });
    if (!banner) return res.status(404).end();
    res.set('Content-Type', banner.contentType);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(banner.data);
});

module.exports = router;
