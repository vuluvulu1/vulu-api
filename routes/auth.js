const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Registration = require('../models/Registration');
const Version = require('../models/Version');
const { createCounter } = require('../middleware/rateLimit');
const { signToken } = require('../middleware/auth');
const { mailEnabled, sendMail, verificationMail } = require('../lib/mail');

const router = express.Router();

// Şifre deneme sınırları: IP başına toplam deneme ve kullanıcı adı başına başarısız deneme (15 dk)
const LOGIN_WINDOW = 15 * 60 * 1000;
const loginsByIp = createCounter({ windowMs: LOGIN_WINDOW, max: 30 });
const failuresByName = createCounter({ windowMs: LOGIN_WINDOW, max: 8 });
const TOO_MANY = 'Çok fazla başarısız deneme. 15 dakika sonra tekrar dene.';
const WRONG = 'Kullanıcı adı veya şifre hatalı.';

// Kullanıcı yokken de aynı süre harcansın diye karşılaştırılan sahte hash (yanıt süresinden ad tahmin edilmesin)
const DUMMY_HASH = bcrypt.hashSync('vulu-dummy-password', 10);

// POST /auth/login
router.post('/login', async (req, res) => {
    // Gövdeden gelen değerler yalnızca metin olarak kullanılır: {"$ne": null} gibi sorgu operatörleri geçemez
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!username || !password || username.length > 32 || password.length > 200)
        return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli.' });

    const nameKey = username.toLowerCase();
    if (loginsByIp.hit(req.ip || 'unknown') || failuresByName.blocked(nameKey))
        return res.status(429).json({ error: TOO_MANY });

    const user = await User.findOne({ username });

    if (!user) {
        // Bekleyen kayıt durumu yalnızca şifre de doğruysa söylenir; aksi halde hangi adların beklediği öğrenilemez
        const pending = await Registration.findOne({ username }).select('passwordHash emailVerified').lean();
        const pendingMatch = await bcrypt.compare(password, pending ? pending.passwordHash : DUMMY_HASH);
        if (pending && pendingMatch)
            return res.status(403).json({ error: pending.emailVerified === false
                ? 'Önce e-posta adresini doğrula; sana gönderdiğimiz bağlantıyı aç.'
                : 'Kaydın henüz onaylanmadı. Bir admin onayladığında giriş yapabilirsin.' });
        failuresByName.hit(nameKey);
        return res.status(401).json({ error: WRONG });
    }

    if (!(await bcrypt.compare(password, user.passwordHash))) {
        failuresByName.hit(nameKey);
        return res.status(401).json({ error: WRONG });
    }
    failuresByName.reset(nameKey);

    // Kapalı hesap ancak doğru şifreyle söylenir
    if (!user.isActive)
        return res.status(403).json({ error: 'Hesabınız devre dışı.' });

    // Topluluk listesinde "son görülme" için. Yalnızca bu alan yazılır (eski kayıtlar şemaya tam uymasa da
    // sorun çıkmaz) ve beklenmez: kaydedilemese bile giriş engellenmez.
    User.updateOne({ _id: user._id }, { $set: { lastSeenAt: new Date() } })
        .catch(err => console.error('lastSeenAt yazılamadı:', err.message));

    res.json({
        token: signToken(user),
        isAdmin: user.isAdmin
    });
});

// POST /auth/register { username, email, password } — kayıt isteği; bir admin onaylayınca hesap açılır.
// (Eskiden gizli anahtarla hesap açan /auth/create-user vardı; yerini bu ve admin onayı aldı.)
const USERNAME = /^[A-Za-z0-9_]{3,16}$/;   // Minecraft çevrimdışı oturumunun kabul ettiği karakterler
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PENDING = 50;                   // toplam bekleyen istek
const MAX_PER_IP_PER_DAY = 3;

const sameName = name => new RegExp(`^${name}$`, 'i'); // ad yalnızca harf/rakam/_ içerdiği için güvenli

const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;   // doğrulanmayan istek bu süreden sonra silinir
const RESEND_GAP_MS = 2 * 60 * 1000;         // aynı isteğe iki doğrulama postası arasında en az bu kadar
const resendsByIp = createCounter({ windowMs: 60 * 60 * 1000, max: 10 });
const verifyHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');

/** İsteğe yeni bir doğrulama bağlantısı üretip postalar. Token'ın kendisi değil SHA-256'sı saklanır. */
async function sendVerification(reg) {
    const token = crypto.randomBytes(32).toString('base64url');
    await Registration.updateOne({ _id: reg._id }, { $set: {
        verifyTokenHash: verifyHash(token), verifySentAt: new Date(), expireAt: new Date(Date.now() + VERIFY_TTL_MS),
    } });
    await sendMail({ to: reg.email, ...verificationMail(reg.username, token) });
}

router.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!USERNAME.test(username))
        return res.status(400).json({ error: 'Kullanıcı adı 3-16 karakter olmalı; yalnızca İngilizce harf, rakam ve _ kullanılabilir.' });
    if (email.length > 254 || !EMAIL.test(email))
        return res.status(400).json({ error: 'Geçerli bir e-posta adresi gir.' });
    // bcrypt ilk 72 baytı kullanır; daha uzunu sessizce kısalmasın diye sınır konur
    if (password.length < 6 || Buffer.byteLength(password) > 72)
        return res.status(400).json({ error: 'Şifre 6-72 karakter olmalı.' });

    if (await User.exists({ username: sameName(username) }))
        return res.status(409).json({ error: 'Bu kullanıcı adı alınmış.' });
    if (await Registration.exists({ username: sameName(username) }))
        return res.status(409).json({ error: 'Bu kullanıcı adıyla bekleyen bir kayıt isteği var.' });
    if (await User.exists({ email }) || await Registration.exists({ email }))
        return res.status(409).json({ error: 'Bu e-posta adresiyle zaten bir hesap ya da kayıt isteği var.' });

    const ip = req.ip || '';
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (await Registration.countDocuments() >= MAX_PENDING
        || (ip && await Registration.countDocuments({ ip, createdAt: { $gte: since } }) >= MAX_PER_IP_PER_DAY))
        return res.status(429).json({ error: 'Şu an çok fazla kayıt isteği var. Daha sonra tekrar dene.' });

    const passwordHash = await bcrypt.hash(password, 10);

    // E-posta gönderimi kurulu değilse (ör. eski sunucu) istek doğrudan admin onayına düşer
    if (!mailEnabled()) {
        await Registration.create({ username, email, passwordHash, ip });
        return res.status(201).json({ success: true, verifyEmail: false });
    }

    const reg = await Registration.create({ username, email, passwordHash, ip, emailVerified: false });
    try {
        await sendVerification(reg);
    } catch (err) {
        console.error('Doğrulama postası:', err.message);
        await Registration.deleteOne({ _id: reg._id });
        return res.status(502).json({ error: 'Doğrulama e-postası gönderilemedi. Biraz sonra tekrar dene.' });
    }
    res.status(201).json({ success: true, verifyEmail: true });
});

// POST /auth/verify-email { token } — e-postadaki bağlantı (sitedeki /dogrula sayfası) bunu çağırır
router.post('/verify-email', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token || token.length > 100) return res.status(400).json({ error: 'Bağlantı geçersiz.' });
    const reg = await Registration.findOneAndUpdate(
        { verifyTokenHash: verifyHash(token), expireAt: { $gt: new Date() } },
        { $set: { emailVerified: true }, $unset: { verifyTokenHash: '', expireAt: '' } },
        { returnDocument: 'after' }).select('username').lean();
    if (!reg) return res.status(400).json({ error: 'Bağlantı geçersiz ya da süresi dolmuş. Katılma isteğini yeniden gönderebilirsin.' });
    res.json({ success: true, username: reg.username });
});

// POST /auth/resend-verification { email } — doğrulama postası gelmediyse. Adresin kayıtlı olup olmadığını
// belli etmemek için her zaman aynı cevap döner.
router.post('/resend-verification', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: 'Geçerli bir e-posta adresi gir.' });
    if (resendsByIp.hit(req.ip || 'unknown')) return res.status(429).json({ error: 'Çok fazla deneme. Biraz sonra tekrar dene.' });
    const ok = { success: true, message: 'Bu adresle doğrulanmayı bekleyen bir istek varsa yeni bir bağlantı gönderdik.' };
    if (!mailEnabled()) return res.json(ok);

    const reg = await Registration.findOne({ email, emailVerified: false });
    if (!reg) return res.json(ok);
    if (reg.verifySentAt && Date.now() - reg.verifySentAt.getTime() < RESEND_GAP_MS)
        return res.status(429).json({ error: 'Az önce bir bağlantı gönderdik. Birkaç dakika bekleyip gelen kutunu ve spam klasörünü kontrol et.' });
    try {
        await sendVerification(reg);
    } catch (err) {
        console.error('Doğrulama postası (yeniden):', err.message);
        return res.status(502).json({ error: 'E-posta gönderilemedi. Biraz sonra tekrar dene.' });
    }
    res.json(ok);
});

// GET /auth/version
router.get('/version', async (req, res) => {
    try {
        const latest = await Version.findOne();
        if (!latest) return res.status(404).json({ error: 'Sürüm bulunamadı.' });
        res.json({ version: latest.version, downloadUrl: latest.downloadUrl });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası.' });
    }
});

module.exports = router;
