require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');

const { limitByIp } = require('./middleware/rateLimit');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
    console.warn('UYARI: JWT_SECRET en az 32 karakterlik rastgele bir değer olmalı.');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
// API bir vekil sunucunun (VDS'te Caddy, Render'da onun vekili) arkasında; kayıt sınırı için gerçek istemci IP'si req.ip'e gelsin
app.set('trust proxy', 1);

// Tarayıcıya yönelik temel güvenlik başlıkları (API yalnızca JSON ve resim döndürür)
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Strict-Transport-Security': 'max-age=31536000',
    });
    next();
});

// vulu web sitesi API'yi tarayıcıdan çağırır; yalnızca listedeki adreslere izin verilir.
// Launcher istekleri C# tarafından Origin başlığı olmadan gelir, bundan etkilenmez.
// CORS_ORIGINS virgülle ayrılmış liste, ör. "https://vulu.vercel.app,http://localhost:5173"
const CORS_ORIGINS = new Set((process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',').map(s => s.trim()).filter(Boolean));
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.has(origin)) {
        res.set({
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '600',
            'Vary': 'Origin',
        });
        if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
});

// Genel sınır: tek bir IP'nin sunucuyu boğmasına karşı (launcher normal kullanımda bunun çok altında kalır)
app.use(limitByIp({ windowMs: 60 * 1000, max: 240, message: 'Çok fazla istek. Biraz bekleyip tekrar dene.' }));

// MongoDB bağlantısı
mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        console.log('MongoDB bağlandı.');
        // Eski sürümlerden kalan paket izinleri (allowedPacks) temizlenir; eşleşen kayıt kalmayınca iş yapmaz
        try { await mongoose.connection.db.collection('users').updateMany({ allowedPacks: { $exists: true } }, { $unset: { allowedPacks: '' } }); }
        catch (err) { console.error('Eski alanlar temizlenemedi:', err.message); }
    })
    .catch(err => console.error('MongoDB bağlantı hatası:', err));

// Route'lar
app.use('/auth', require('./routes/auth'));
app.use('/users', require('./routes/users'));
app.use('/packs', require('./routes/packs'));
app.use('/feedback', require('./routes/feedback'));
app.use('/servers', require('./routes/servers'));
app.use('/messages', require('./routes/messages'));
app.use('/shots', require('./routes/shots'));
app.use('/announcements', require('./routes/announcements'));
app.use('/admin', require('./routes/admin'));
app.use('/yggdrasil', require('./routes/yggdrasil').router);

// Sağlık kontrolü
app.get('/ping', (req, res) => res.json({ status: 'ok' }));

// Beklenmeyen hatalar launcher'a anlaşılır bir mesajla döner (Express 5 async hataları buraya iletir).
// Sebep launcher'da görünsün diye hatanın kısa mesajı da eklenir; tam ayrıntı sunucu loglarındadır.
app.use((err, req, res, next) => {
    console.error(`${req.method} ${req.originalUrl}:`, err);
    if (res.headersSent) return next(err);

    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'İstek çok büyük.' });

    // Atlas'ta sunucunun veritabanı kullanıcısına yazma izni verilmemişse
    if (err.code === 13 || /not authorized|unauthorized/i.test(err.message || ''))
        return res.status(500).json({ error: 'Sunucunun veritabanı kullanıcısının yazma izni yok (Atlas → Database Access → readWrite).' });

    const detail = String(err.message || '').split('\n')[0].slice(0, 160);
    res.status(err.status || 500).json({ error: detail ? `Sunucu hatası: ${detail}` : 'Sunucu hatası.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API çalışıyor: http://localhost:${PORT}`));
