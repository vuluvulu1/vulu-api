// Tek seferlik kullanım: node seed-security-question.js
// Soru/cevabı DB'ye ekler veya günceller.

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const SecurityQuestion = require('./models/SecurityQuestion');

const KEY = '?';
const QUESTION = 'Bu sürüme erişmek için çok önemli olan bir yıl dönümünden, çok önemli olan birinin doğum gününü çıkar. (Gün,Ay,Yıl)';
const ANSWER = '?'; // mevcut cevabın aynısı — istersen değiştir

async function seed() {
    await mongoose.connect(process.env.MONGO_URI);

    const answerHash = await bcrypt.hash(ANSWER, 10);

    const result = await SecurityQuestion.findOneAndUpdate(
        { key: KEY },
        { key: KEY, question: QUESTION, answerHash },
        { upsert: true, new: true }
    );

    console.log('Kaydedildi:', { key: result.key, question: result.question });

    await mongoose.disconnect();
}

seed().catch(err => {
    console.error('Hata:', err);
    process.exit(1);
});