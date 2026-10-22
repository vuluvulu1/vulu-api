const mongoose = require('mongoose');

// Discord'daki roller gibi: admin oluşturur ve kullanıcılara verir. Bir pakete rol seçilirse paketi yalnızca o
// rollerden birine sahip olanlar (ve adminler) görür; rol seçilmemiş paket herkese açıktır.
const roleSchema = new mongoose.Schema({
    name: { type: String, required: true, maxlength: 24 },
    key: { type: String, required: true, unique: true },   // adın küçük harfli hali: aynı ad iki kez kullanılamaz
    color: { type: String, default: '#9c704c' },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Role', roleSchema);
