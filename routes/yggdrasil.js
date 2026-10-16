const express = require('express');
const crypto = require('crypto');
const User = require('../models/User');
const Skin = require('../models/Skin');
const GameSession = require('../models/GameSession');
const { offlineUuid, signingKey, profileOf, baseUrlOf } = require('../lib/yggdrasil');

/**
 * Oyunun skin ve oturum için konuştuğu uç noktalar (authlib-injector'ın "Yggdrasil" API'si).
 * Launcher oyunu authlib-injector ile başlatır; oyun Mojang yerine buraya sorar:
 *   - kendi ve diğer oyuncuların profilleri ve skinleri,
 *   - LAN'a ya da sunucuya katılırken kimlik doğrulama (join / hasJoined).
 * Hesap girişi launcher'dadır; buradaki authserver uç noktaları yalnızca token denetimi yapar.
 */
const router = express.Router();

const UUID = /^[0-9a-f]{32}$/;
const NAME = /^[A-Za-z0-9_]{1,16}$/;
const JOIN_TTL_MS = 30 * 1000;
const joins = new Map(); // serverId → { username, profileId, ip, at }

const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const forbidden = (res, message) => res.status(403).json({ error: 'ForbiddenOperationException', errorMessage: message });

async function userByProfileId(profileId) {
    // Kimlik addan türetilir; kullanıcı sayısı az olduğu için aktif kullanıcılar arasında aranır
    const users = await User.find({ isActive: { $ne: false } }).select('username skinHash skinModel').lean();
    return users.find(u => offlineUuid(u.username) === profileId) || null;
}

const activeUser = username => User.findOne({ username, isActive: { $ne: false } }).select('username skinHash skinModel').lean();

// GET /yggdrasil/ — API bilgisi ve imza doğrulama anahtarı
router.get('/', async (req, res) => {
    const { publicKey } = await signingKey();
    res.json({
        meta: {
            serverName: 'vulu',
            implementationName: 'vulu-api',
            implementationVersion: '1',
            'feature.non_email_login': true,
        },
        skinDomains: [req.hostname],
        signaturePublickey: publicKey,
    });
});

// GET /yggdrasil/textures/:hash — skin resmi (herkese açık, içerik değişmez)
router.get('/textures/:hash', async (req, res) => {
    if (!/^[0-9a-f]{64}$/.test(req.params.hash)) return res.status(404).end();
    const skin = await Skin.findOne({ hash: req.params.hash }).lean();
    if (!skin) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    // Launcher skin önizlemesini canvas'a çizer (crossOrigin); resim zaten herkese açık
    res.set('Access-Control-Allow-Origin', '*');
    res.send(skin.data.buffer ? Buffer.from(skin.data.buffer) : skin.data);
});

// GET /yggdrasil/sessionserver/session/minecraft/profile/:uuid?unsigned=false
router.get('/sessionserver/session/minecraft/profile/:uuid', async (req, res) => {
    const uuid = String(req.params.uuid).replace(/-/g, '').toLowerCase();
    if (!UUID.test(uuid)) return res.status(204).end();
    const user = await userByProfileId(uuid);
    if (!user) return res.status(204).end();
    res.json(await profileOf(user, baseUrlOf(req), req.query.unsigned === 'false'));
});

// POST /yggdrasil/sessionserver/session/minecraft/join — istemci bir sunucuya katılmadan önce
router.post('/sessionserver/session/minecraft/join', async (req, res) => {
    const { accessToken, selectedProfile, serverId } = req.body || {};
    if (typeof accessToken !== 'string' || typeof selectedProfile !== 'string' || typeof serverId !== 'string' || serverId.length > 64)
        return forbidden(res, 'Invalid token.');

    const session = await GameSession.findOne({ tokenHash: tokenHash(accessToken) }).lean();
    if (!session || session.profileId !== selectedProfile.replace(/-/g, '').toLowerCase())
        return forbidden(res, 'Invalid token.');
    if (!(await activeUser(session.username))) return forbidden(res, 'Invalid token.');

    joins.set(serverId, { username: session.username, profileId: session.profileId, ip: req.ip, at: Date.now() });
    res.status(204).end();
});

// GET /yggdrasil/sessionserver/session/minecraft/hasJoined?username=&serverId=&ip= — sunucu oyuncuyu doğrular
router.get('/sessionserver/session/minecraft/hasJoined', async (req, res) => {
    const join = joins.get(String(req.query.serverId || ''));
    if (!join || Date.now() - join.at > JOIN_TTL_MS || join.username !== req.query.username) return res.status(204).end();
    if (req.query.ip && req.query.ip !== join.ip) return res.status(204).end();
    joins.delete(String(req.query.serverId));

    const user = await activeUser(join.username);
    if (!user) return res.status(204).end();
    res.json(await profileOf(user, baseUrlOf(req), true));
});

// POST /yggdrasil/api/profiles/minecraft — adlardan kimliklere (en çok 10 ad)
router.post('/api/profiles/minecraft', async (req, res) => {
    const names = Array.isArray(req.body) ? req.body.filter(n => typeof n === 'string' && NAME.test(n)).slice(0, 10) : [];
    const users = await User.find({ username: { $in: names }, isActive: { $ne: false } }).select('username').lean();
    res.json(users.map(u => ({ id: offlineUuid(u.username), name: u.username })));
});

// GET /yggdrasil/api/users/profiles/minecraft/:name
router.get('/api/users/profiles/minecraft/:name', async (req, res) => {
    if (!NAME.test(req.params.name)) return res.status(204).end();
    const user = await activeUser(req.params.name);
    if (!user) return res.status(204).end();
    res.json({ id: offlineUuid(user.username), name: user.username });
});

// Hesap girişi launcher'dadır; oyun içinden şifreyle giriş yapılmaz
router.post('/authserver/validate', async (req, res) => {
    const session = typeof req.body?.accessToken === 'string'
        ? await GameSession.findOne({ tokenHash: tokenHash(req.body.accessToken) }).lean() : null;
    if (!session) return forbidden(res, 'Invalid token.');
    res.status(204).end();
});
router.post(['/authserver/authenticate', '/authserver/refresh', '/authserver/signout', '/authserver/invalidate'],
    (req, res) => forbidden(res, 'vulu Launcher ile giriş yap.'));

// Süresi dolan katılma kayıtları ara ara temizlenir
setInterval(() => {
    const now = Date.now();
    for (const [id, join] of joins) if (now - join.at > JOIN_TTL_MS) joins.delete(id);
}, 60 * 1000).unref();

module.exports = { router, tokenHash };
