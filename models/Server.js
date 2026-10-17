const mongoose = require('mongoose');

// vulu sunucuları: adminlerin launcher'a eklediği sunucular. Launcher durumlarını kendisi sorgular (sunucu listesi
// protokolü); "Bağlan" bağlı paketin instance'ını açıp doğrudan sunucuya girer.
const serverSchema = new mongoose.Schema({
    name: { type: String, required: true, maxlength: 40 },
    address: { type: String, required: true, maxlength: 120 },   // host ya da host:port
    description: { type: String, default: '', maxlength: 200 },
    packId: { type: String, default: null },                      // bağlı vulu paketi (yoksa Vanilla)
    mcVersion: { type: String, default: '' },                     // Vanilla sunucular için
    order: { type: Number, default: 0 },
    createdBy: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Server', serverSchema);
