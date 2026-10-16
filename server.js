require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json({ limit: '2mb' }));
// Render bir vekil sunucunun arkasında; kayıt sınırı için gerçek istemci IP'si req.ip'e gelsin
app.set('trust proxy', 1);

// MongoDB bağlantısı
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB bağlandı.'))
    .catch(err => console.error('MongoDB bağlantı hatası:', err));

// Route'lar
app.use('/auth', require('./routes/auth'));
app.use('/users', require('./routes/users'));
app.use('/packs', require('./routes/packs'));
app.use('/feedback', require('./routes/feedback'));
app.use('/admin', require('./routes/admin'));

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
