require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// MongoDB bağlantısı
mongoose.connect(process.env.MONGO_URL)
    .then(() => console.log('MongoDB bağlandı.'))
    .catch(err => console.error('MongoDB bağlantı hatası:', err));

// Route'lar
app.use('/auth', require('./routes/auth'));
app.use('/manifest', require('./routes/manifest'));

// Sağlık kontrolü
app.get('/ping', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
