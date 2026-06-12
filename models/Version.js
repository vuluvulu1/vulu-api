const mongoose = require('mongoose');

const versionSchema = new mongoose.Schema({
    version: { type: String, required: true },
    downloadUrl: { type: String, required: true }
});

module.exports = mongoose.model('Version', versionSchema, 'versions');
