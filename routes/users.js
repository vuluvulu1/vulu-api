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
const Presence = require('../models/Presence');
const Friendship = require('../models/Friendship');
const Registration = require('../models/Registration');
const Device = require('../models/Device');
const { mailEnabled, sendMail, emailChangeMail } = require('../lib/mail');
const { offlineUuid, baseUrlOf } = require('../lib/yggdrasil');
const { tokenHash } = require('./yggdrasil');
const { requireAuth, requirePackReader, signToken, PANEL_PREFIX, panelTokenHash } = require('../middleware/auth');
const { visiblePacksQuery, roleMap, rolesOf } = require('../lib/access');
const settings = require('../lib/settings');

const router = express.Router();

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const BANNER_MAX_BYTES = 1.5 * 1024 * 1024;   // launcher büyük resimleri yüklemeden önce küçültür
const MAX_BIO = 300;

// Şifre hash'i ve izinler asla dışarı verilmez. roles: profildeki rol rozetleri ({ id, name, color })
function publicProfile(user, packCount = 0, roles = new Map()) {
    return {
        username: user.username,
        bio: user.bio || '',
        isAdmin: !!user.isAdmin,
        roles: rolesOf(user, roles),
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

/** Yazar başına, bakan kullanıcının görebildiği paket sayısı. */
async function packCounts(viewer) {
    const rows = await Pack.aggregate([{ $match: visiblePacksQuery(viewer) }, { $group: { _id: '$author', count: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map(r => [r._id, r.count]));
}

// GET /users — bütün aktif kullanıcılar
router.get('/', requireAuth, async (req, res) => {
    const [users, counts, roles] = await Promise.all([
        User.find({ isActive: true }).sort({ lastSeenAt: -1, username: 1 }),
        packCounts(req.user),
        roleMap(),
    ]);
    res.json(users.map(u => publicProfile(u, counts[u.username] || 0, roles)));
});

// ── Çevrimiçi durum (arkadaş listesi) ────────────────────────────────
// Launcher 45 sn'de bir bildirir; veritabanında tutulur (models/Presence.js).
// 2 dakika ses gelmeyen çevrimdışı sayılır. Kullanıcı ayarlardan ayrıntıları gizleyebilir ya da hiç bildirmeyebilir.
const PRESENCE_TTL = 2 * 60 * 1000;
const PRESENCE_STATES = ['launcher', 'playing', 'online'];
const short = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

// POST /users/me/presence { state, instance?, mcVersion?, loader?, packId?, server? }
router.post('/me/presence', requireAuth, async (req, res) => {
    const b = req.body || {};
    const state = PRESENCE_STATES.includes(b.state) ? b.state : 'online';
    const playing = state === 'playing';
    const prev = await Presence.findById(req.user.username).lean();
    const entry = {
        state,
        instance: playing ? short(b.instance, 60) : '',
        mcVersion: playing ? short(b.mcVersion, 40) : '',
        loader: playing ? short(b.loader, 20) : '',
        packId: playing && /^[0-9a-f]{24}$/.test(b.packId || '') ? b.packId : null,
        server: playing ? short(b.server, 120) : '',
        at: new Date(),
    };
    // "since": bu duruma ne zaman geçildiği (aynı oyunda kaldıkça değişmez); süresi dolmuş kayıt yeni oturum sayılır
    const fresh = prev && Date.now() - new Date(prev.at).getTime() <= PRESENCE_TTL;
    entry.since = fresh && prev.state === entry.state && prev.instance === entry.instance ? prev.since : new Date();
    await Presence.updateOne({ _id: req.user.username }, { $set: entry }, { upsert: true });
    // Son görülme veritabanına en fazla 5 dakikada bir yazılır
    if (!req.user.lastSeenAt || Date.now() - new Date(req.user.lastSeenAt).getTime() > 5 * 60 * 1000)
        User.updateOne({ _id: req.user._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
    res.json({ ok: true });
});

// DELETE /users/me/presence — launcher kapanırken
router.delete('/me/presence', requireAuth, async (req, res) => {
    await Presence.deleteOne({ _id: req.user.username });
    res.json({ ok: true });
});

// GET /users/presence — çevrimiçi olanlar ve ne oynadıkları (herkes görür). friend: bakan kişinin arkadaşı mı
router.get('/presence', requireAuth, async (req, res) => {
    const [list, friends] = await Promise.all([
        Presence.find({ at: { $gt: new Date(Date.now() - PRESENCE_TTL) } }).lean(),
        Friendship.friendsOf(req.user.username),
    ]);
    const mine = new Set(friends);
    res.json(list.map(p => ({
        username: p._id, state: p.state, instance: p.instance, mcVersion: p.mcVersion, loader: p.loader,
        packId: p.packId, server: p.server, since: new Date(p.since).toISOString(), friend: mine.has(p._id),
    })));
});

// GET /users/me — kendi profilin; e-posta (ve doğrulanmayı bekleyen yeni adres) yalnızca burada görünür
router.get('/me', requireAuth, async (req, res) => {
    const [counts, roles] = await Promise.all([packCounts(req.user), roleMap()]);
    const pending = req.user.pendingEmail && req.user.emailTokenExpires > new Date() ? req.user.pendingEmail : null;
    const mc = req.user.minecraft?.uuid ? { uuid: req.user.minecraft.uuid, name: req.user.minecraft.name, verifiedAt: req.user.minecraft.verifiedAt } : null;
    res.json({ ...publicProfile(req.user, counts[req.user.username] || 0, roles), email: req.user.email || '', pendingEmail: pending,
        minecraft: mc, ownershipRequired: await settings.get('requireMinecraftOwnership'),
        notifications: { registrations: req.user.notifyRegistrations !== false } });
});

// ── Push bildirimi alan cihazlar (vulu Sosyal) ───────────────────────
const FCM_TOKEN = /^[A-Za-z0-9_:\-]{20,4096}$/;
const MAX_DEVICES = 10;

// POST /users/me/devices { token, platform: 'android' } — girişten sonra telefon kendini kaydeder. Aynı token başka
// bir hesaptaysa (telefonda hesap değişti) bu hesaba geçer. Bir hesapta en fazla 10 cihaz; fazlası en eskiden silinir.
router.post('/me/devices', requireAuth, async (req, res) => {
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (!FCM_TOKEN.test(token)) return res.status(400).json({ error: 'Cihaz token\'ı geçersiz.' });
    const platform = req.body.platform === undefined ? 'android' : req.body.platform;
    if (platform !== 'android') return res.status(400).json({ error: 'Desteklenmeyen platform.' });

    await Device.updateOne({ token },
        { $set: { username: req.user.username, platform, lastSeenAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true });
    const extra = await Device.find({ username: req.user.username }).sort({ lastSeenAt: -1 }).skip(MAX_DEVICES).select('_id').lean();
    if (extra.length) await Device.deleteMany({ _id: { $in: extra.map(d => d._id) } });
    res.json({ success: true });
});

// DELETE /users/me/devices/:token — çıkış yapınca telefon bildirim almayı bırakır
router.delete('/me/devices/:token', requireAuth, async (req, res) => {
    await Device.deleteOne({ token: String(req.params.token), username: req.user.username });
    res.json({ success: true });
});

// PUT /users/me/notifications { registrations?: boolean } — telefona gelen bildirim tercihleri
router.put('/me/notifications', requireAuth, async (req, res) => {
    if (typeof req.body.registrations === 'boolean') await setFields(req.user, { notifyRegistrations: req.body.registrations });
    res.json({ registrations: req.user.notifyRegistrations !== false });
});

// POST /users/me/minecraft { accessToken } — Microsoft hesabını bağlar. Launcher'ın Microsoft girişinden aldığı
// Minecraft token'ıyla sunucu Minecraft servislerine profili sorar: profil varsa kişi oyuna sahiptir. Token saklanmaz.
const UUID_RE = /^[0-9a-f]{32}$/;
router.post('/me/minecraft', requireAuth, async (req, res) => {
    const accessToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken.trim() : '';
    if (!accessToken || accessToken.length > 4096) return res.status(400).json({ error: 'Microsoft oturumu eksik.' });
    let profile;
    try {
        const response = await fetch('https://api.minecraftservices.com/minecraft/profile', {
            headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15 * 1000) });
        if (response.status === 404) return res.status(403).json({ error: 'Bu Microsoft hesabında Minecraft: Java Edition yok.' });
        if (response.status === 401) return res.status(401).json({ error: 'Microsoft oturumunun süresi dolmuş; tekrar giriş yap.' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        profile = await response.json();
    } catch (err) {
        console.error('Minecraft profili:', err.message);
        return res.status(502).json({ error: 'Minecraft servislerine ulaşılamadı. Biraz sonra tekrar dene.' });
    }
    const uuid = String(profile?.id || '').toLowerCase();
    const name = String(profile?.name || '');
    if (!UUID_RE.test(uuid) || !name) return res.status(502).json({ error: 'Minecraft servisleri beklenmedik bir cevap verdi.' });
    if (await User.exists({ 'minecraft.uuid': uuid, _id: { $ne: req.user._id } }))
        return res.status(409).json({ error: `${name} adlı Minecraft hesabı başka bir vulu hesabına bağlı.` });
    const minecraft = { uuid, name, verifiedAt: new Date() };
    await User.updateOne({ _id: req.user._id }, { $set: { minecraft } });
    res.json({ success: true, minecraft });
});

// DELETE /users/me/minecraft — bağlantıyı kaldırır
router.delete('/me/minecraft', requireAuth, async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $unset: { minecraft: '' } });
    res.json({ success: true });
});

// POST /users/me/email { email, password } — e-posta adresini değiştirir. E-posta gönderimi kuruluysa yeni adres
// postadaki bağlantı açılınca geçerli olur (yanlış yazılan adres hesabı kilitlemesin); kurulu değilse hemen değişir.
const EMAIL_CHANGE_TTL_MS = 48 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
router.post('/me/email', requireAuth, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi gir.' });
    if (!password || !(await bcrypt.compare(password, req.user.passwordHash)))
        return res.status(401).json({ error: 'Şifre hatalı.' });
    if ((req.user.email || '') === email) return res.status(400).json({ error: 'Hesabının adresi zaten bu.' });
    if (await User.exists({ email, _id: { $ne: req.user._id } }) || await Registration.exists({ email }))
        return res.status(409).json({ error: 'Bu e-posta adresi başka bir hesapta ya da kayıt isteğinde kullanılıyor.' });

    if (!mailEnabled()) {
        await User.updateOne({ _id: req.user._id }, { $set: { email }, $unset: { pendingEmail: '', emailTokenHash: '', emailTokenExpires: '' } });
        return res.json({ success: true, pending: false, email, message: 'E-posta adresin değişti.' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    await User.updateOne({ _id: req.user._id }, { $set: {
        pendingEmail: email,
        emailTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        emailTokenExpires: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
    } });
    try {
        await sendMail({ to: email, ...emailChangeMail(req.user.username, token) });
    } catch (err) {
        console.error('E-posta değişikliği postası:', err.message);
        return res.status(502).json({ error: 'Doğrulama e-postası gönderilemedi. Biraz sonra tekrar dene.' });
    }
    res.json({ success: true, pending: true, email, message: `${email} adresine bir doğrulama bağlantısı gönderdik. Bağlantıyı açınca adresin değişecek.` });
});

// PUT /users/me — açıklama
router.put('/me', requireAuth, async (req, res) => {
    const bio = String(req.body.bio ?? '').trim();
    if (bio.length > MAX_BIO) return res.status(400).json({ error: `Açıklama en fazla ${MAX_BIO} karakter olabilir.` });

    await setFields(req.user, { bio });
    res.json(publicProfile(req.user, 0, await roleMap()));
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
    res.json(publicProfile(req.user, 0, await roleMap()));
});

// DELETE /users/me/avatar
router.delete('/me/avatar', requireAuth, async (req, res) => {
    await Avatar.deleteOne({ username: req.user.username });
    await setFields(req.user, { avatarVersion: 0 });
    res.json(publicProfile(req.user, 0, await roleMap()));
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
    res.json(publicProfile(req.user, 0, await roleMap()));
});

// DELETE /users/me/banner
router.delete('/me/banner', requireAuth, async (req, res) => {
    await Banner.deleteOne({ username: req.user.username });
    await setFields(req.user, { bannerVersion: 0 });
    res.json(publicProfile(req.user, 0, await roleMap()));
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
    res.json(publicProfile(req.user, 0, await roleMap()));
});

// PUT /users/me/skin/model { model } — yalnızca beden tipi (Klasik / İnce)
router.put('/me/skin/model', requireAuth, async (req, res) => {
    const model = req.body.model === 'slim' ? 'slim' : 'default';
    await setFields(req.user, { skinModel: model });
    res.json(publicProfile(req.user, 0, await roleMap()));
});

// DELETE /users/me/skin — varsayılan skine dönülür
router.delete('/me/skin', requireAuth, async (req, res) => {
    const previous = req.user.skinHash;
    await setFields(req.user, { skinHash: '', skinModel: 'default' });
    await dropUnusedSkin(previous);
    res.json(publicProfile(req.user, 0, await roleMap()));
});

// POST /users/me/game-session — launcher oyunu başlatırken alır; oyun LAN'a/sunucuya katılırken bununla doğrulanır
router.post('/me/game-session', requireAuth, async (req, res) => {
    // Halka açık sunucuda oyun yalnızca Minecraft'a sahip olduğu doğrulanmış hesaplarla açılır
    if (await settings.get('requireMinecraftOwnership') && !req.user.minecraft?.uuid)
        return res.status(403).json({ error: 'Oynamak için önce Microsoft hesabını bağla (Ayarlar → Hesap).', code: 'ownership-required' });
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
    // Telefonlar da yeniden giriş yapana kadar bildirim almaz (şifresi ele geçirilen hesapta saldırganınki dahil)
    await Device.deleteMany({ username: req.user.username });
    res.json({ success: true, token: signToken(req.user) });
});

// GET /users/:username — profil ve paylaştığı paketler
router.get('/:username', requireAuth, async (req, res) => {
    const user = await User.findOne({ username: req.params.username, isActive: true });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

    const packs = await Pack.find({ author: user.username, ...visiblePacksQuery(req.user) }).sort({ updatedAt: -1 })
        .select('name revision updatedAt mcVersion loader coverFileId').lean();

    res.json({
        ...publicProfile(user, packs.length, await roleMap()),
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
