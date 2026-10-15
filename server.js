require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json({ limit: '2mb' }));

// MongoDB bağlantısı
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB bağlandı.'))
    .catch(err => console.error('MongoDB bağlantı hatası:', err));

// Route'lar
app.use('/auth', require('./routes/auth'));
app.use('/users', require('./routes/users'));
app.use('/packs', require('./routes/packs'));

// Sağlık kontrolü
app.get('/ping', (req, res) => res.json({ status: 'ok' }));

// Beklenmeyen hatalar launcher'a anlaşılır bir mesajla döner (Express 5 async hataları buraya iletir)
app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.type === 'entity.too.large' ? 'İstek çok büyük.' : 'Sunucu hatası.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API çalışıyor: http://localhost:${PORT}`));
