const jwt = require('jsonwebtoken');
const User = require('../models/User');

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
        payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return res.status(401).json({ error: 'Oturum süresi doldu, tekrar giriş yapın.' });
    }

    const user = await User.findOne({ username: payload.username });
    if (!user || !user.isActive) return res.status(403).json({ error: 'Hesabınız devre dışı.' });

    req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Bu işlem için admin yetkisi gerekli.' });
    next();
}

module.exports = { requireAuth, requireAdmin };
