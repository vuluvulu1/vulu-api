const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const PanelToken = require('../models/PanelToken');

const TOKEN_LIFETIME = '7d';

/**
 * Oturum token'ı. tokenVersion kullanıcının şifresi her değiştiğinde artar; eski token'lar böylece geçersiz olur
 * (şifresi ele geçirilip değiştirilen hesapta saldırganın oturumu da kapanır).
 */
function signToken(user) {
    return jwt.sign(
        { username: user.username, v: user.tokenVersion || 0 },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: TOKEN_LIFETIME });
}

/**
 * Bearer token'ı doğrular ve kullanıcıyı veritabanından yeniden okur.
 * Token 7 gün geçerli olduğu için admin/aktiflik bilgisi token'dan değil veritabanından alınır;
 * böylece hesabı kapatılan ya da adminliği alınan biri hemen yetkisini kaybeder.
 */
async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Giriş yapmalısınız.' });

    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        return res.status(401).json({ error: 'Oturum süresi doldu, tekrar giriş yapın.' });
    }
    if (typeof payload.username !== 'string')
        return res.status(401).json({ error: 'Oturum süresi doldu, tekrar giriş yapın.' });

    const user = await User.findOne({ username: payload.username });
    if (!user || !user.isActive) return res.status(403).json({ error: 'Hesabınız devre dışı.' });
    if ((payload.v || 0) !== (user.tokenVersion || 0))
        return res.status(401).json({ error: 'Şifren değiştiği için oturum kapandı, tekrar giriş yap.' });

    req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Bu işlem için admin yetkisi gerekli.' });
    next();
}

const PANEL_PREFIX = 'vpt_';
const panelTokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Paketleri okuyan uç noktalar için: launcher oturumu ya da vulu Server Panel token'ı (vpt_…) kabul edilir.
 * Panel token'ı başka hiçbir uç noktada geçmez.
 */
async function requirePackReader(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token.startsWith(PANEL_PREFIX)) return requireAuth(req, res, next);

    const record = await PanelToken.findOne({ tokenHash: panelTokenHash(token) });
    if (!record) return res.status(401).json({ error: 'Panel bağlantısı geçersiz; paneli vulu hesabına yeniden bağla.' });
    const user = await User.findOne({ username: record.username });
    if (!user || !user.isActive) return res.status(403).json({ error: 'Hesabınız devre dışı.' });
    if ((record.tokenVersion || 0) !== (user.tokenVersion || 0)) {
        await PanelToken.deleteOne({ _id: record._id });
        return res.status(401).json({ error: 'Şifre değiştiği için panel bağlantısı kapandı; paneli yeniden bağla.' });
    }
    // Son kullanım günde bir yazılır (her istekte değil)
    if (!record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > 24 * 60 * 60 * 1000)
        await PanelToken.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } });
    req.user = user;
    req.panelToken = record;
    next();
}

module.exports = { requireAuth, requireAdmin, requirePackReader, signToken, PANEL_PREFIX, panelTokenHash };
