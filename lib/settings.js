// Admin ayarları: varsayılanlar burada, değişenler Setting koleksiyonunda. Okumalar kısa süre önbellekte tutulur.
const Setting = require('../models/Setting');

const DEFAULTS = {
    // 'admin': e-posta doğrulandıktan sonra bir admin onaylar; 'auto': doğrulanınca hesap kendiliğinden açılır.
    // Microsoft girişi (Minecraft sahipliği doğrulaması) çalışana kadar admin onayı kalır.
    registrationApproval: 'admin',
    // Açıkken oyun yalnızca Microsoft hesabını bağlamış (Minecraft'a sahip olduğu doğrulanmış) hesaplarla açılır
    requireMinecraftOwnership: false,
};
const ALLOWED = {
    registrationApproval: v => v === 'auto' || v === 'admin',
    requireMinecraftOwnership: v => typeof v === 'boolean',
};

const CACHE_MS = 15 * 1000;
let cache = null, cachedAt = 0;

async function all() {
    if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
    const rows = await Setting.find({ key: { $in: Object.keys(DEFAULTS) } }).lean();
    cache = { ...DEFAULTS };
    for (const row of rows) if (ALLOWED[row.key]?.(row.value)) cache[row.key] = row.value;
    cachedAt = Date.now();
    return cache;
}

async function get(key) {
    return (await all())[key];
}

/** Bilinen ve geçerli değerleri yazar; geçersiz bir alan varsa hata fırlatır. */
async function update(changes) {
    for (const [key, value] of Object.entries(changes)) {
        if (!ALLOWED[key]) throw Object.assign(new Error(`Bilinmeyen ayar: ${key}`), { status: 400 });
        if (!ALLOWED[key](value)) throw Object.assign(new Error(`Geçersiz değer: ${key}`), { status: 400 });
    }
    for (const [key, value] of Object.entries(changes))
        await Setting.updateOne({ key }, { $set: { value, updatedAt: new Date() } }, { upsert: true });
    cache = null;
    return all();
}

module.exports = { get, all, update, DEFAULTS };
