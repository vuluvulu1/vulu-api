const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Çevrimdışı oyuncu kimliği: Minecraft'ın "OfflinePlayer:<ad>" için ürettiği UUID'nin aynısı (MD5, sürüm 3).
 * Skin sistemi bunu kullanır; böylece eski dünyalardaki envanter ve ilerleme aynı oyuncuya ait kalır.
 */
function offlineUuid(username) {
    const hash = crypto.createHash('md5').update('OfflinePlayer:' + username, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    return hash.toString('hex');
}

/**
 * Skin bilgisini imzalayan RSA anahtarı. İlk açılışta üretilir ve veritabanında saklanır; böylece sunucu
 * yeniden başlasa da aynı kalır (oyunlar açık anahtarı API'nin kök adresinden alır).
 */
let keyPromise = null;
function signingKey() {
    if (!keyPromise) keyPromise = (async () => {
        const col = mongoose.connection.db.collection('secrets');
        let doc = await col.findOne({ _id: 'yggdrasil-signing-key' });
        if (!doc) {
            const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
                modulusLength: 4096,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
            doc = { _id: 'yggdrasil-signing-key', publicKey, privateKey, createdAt: new Date() };
            // Aynı anda iki istek üretirse ilk yazılan kazanır
            try { await col.insertOne(doc); } catch { doc = await col.findOne({ _id: 'yggdrasil-signing-key' }); }
        }
        return { publicKey: doc.publicKey, privateKey: doc.privateKey };
    })().catch(err => { keyPromise = null; throw err; });
    return keyPromise;
}

async function sign(value) {
    const { privateKey } = await signingKey();
    return crypto.sign('sha1', Buffer.from(value), privateKey).toString('base64');
}

/** Oyunun beklediği profil: ad, kimlik ve (varsa) skin adresini taşıyan imzalı "textures" özelliği. */
async function profileOf(user, baseUrl, signed) {
    const id = offlineUuid(user.username);
    const textures = {};
    if (user.skinHash) {
        textures.SKIN = { url: `${baseUrl}/yggdrasil/textures/${user.skinHash}` };
        if (user.skinModel === 'slim') textures.SKIN.metadata = { model: 'slim' };
    }
    const value = Buffer.from(JSON.stringify({
        timestamp: Date.now(), profileId: id, profileName: user.username,
        ...(signed ? { signatureRequired: true } : {}),
        textures,
    })).toString('base64');

    const property = { name: 'textures', value };
    if (signed) property.signature = await sign(value);
    return { id, name: user.username, properties: [property] };
}

/** API'nin dışarıdan görünen adresi (Render'da https, yerelde http://localhost:PORT). */
function baseUrlOf(req) {
    return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

module.exports = { offlineUuid, signingKey, profileOf, baseUrlOf };
