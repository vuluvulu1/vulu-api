const mongoose = require('mongoose');

const securityQuestionSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    question: { type: String, required: true },
    answerHash: { type: String, required: true }
});

module.exports = mongoose.model('SecurityQuestion', securityQuestionSchema, 'securityquestions');