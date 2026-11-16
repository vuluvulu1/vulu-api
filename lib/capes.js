// vulu Pelerinleri: satılmaz; oynayarak, sezon görevleriyle ve etkinlik kazanarak alınır.
//
// Oyunda görünme yolu: launcher oyunu authlib-injector ile vulu'nun Yggdrasil API'sine bağlar; vulu-resmi sunucusu da
// aynı ajanla çalışır (online-mode=true). Oyuncunun profilindeki imzalı "textures" özelliğine SKIN'in yanına CAPE
// eklenince, sunucu bu özelliği herkese iletir ve oyunun kendisi pelerini çizer (tek oyunculuda ve LAN'da da). İstemciye
// ya da sunucuya mod gerekmez; Mojang pelerinleriyle aynı yol.
//
// Katalog veritabanında durur (capes koleksiyonu) ve admin panelinden yönetilir: pelerin eklenir, silinir, adı ve
// açıklaması değişir. Doku üç yoldan gelir: desen (zemin, kenar, amblem renkleri; burada çizilir), hazır çizim
// (lib/capeArt.js) ya da adminin yüklediği 64×32 PNG. Dokular skinlerle aynı koleksiyonda, içeriklerinin SHA-256'sıyla
// saklanır: oyun /yggdrasil/textures/<hash> adresinden indirir. Koleksiyon boşsa aşağıdaki varsayılanlar yazılır;
// sonradan eklenen varsayılanlar (yeni konseptler) da eksikse eklenir.
//
// adminOnly: yalnızca adminler takabilir; adminlerde kendiliğinden vardır, başkasına verilemez.
'use strict';
const crypto = require('crypto');
const { PNG } = require('pngjs');
const { drawArt, ART_NAMES } = require('./capeArt');

const hex = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const E = '..........';

// Pelerinin dış yüzü 10×16 piksel. Amblemler: '#' = amblem rengi, '+' = ikinci renk, '.' = boş
const EMBLEMS = {
    none: Array(16).fill(E),
    v: [E, E, E, '..#....#..', '..#....#..', '..##..##..', '...#..#...', '...####...', '....##....', E, E, E, E, E, E, E],
    crown: [E, E, E, '..#..#..#.', '..#.###.#.', '..#######.', '..#+###+#.', '..#######.', E, E, E, E, E, E, E, E],
    trophy: [E, E, '.########.', '.#.####.#.', '.#.####.#.', '..######..', '...####...', '....##....', '....##....', '...####...', '..######..', E, E, E, E, E],
    one: [E, E, '....##....', '...###....', '..####....', '....##....', '....##....', '....##....', '....##....', '....##....', '..######..', E, E, E, E, E],
    star: [E, E, '....##....', '....##....', '.########.', '..######..', '...####...', '..##..##..', '..#....#..', E, E, E, E, E, E, E],
    flame: [E, E, '....#.....', '....##....', '...###....', '...####...', '..##+###..', '..#+++##..', '..#+++##..', '...####...', E, E, E, E, E, E],
    heart: [E, E, E, '..##.##...', '.#######..', '.##+####..', '.#######..', '..#####...', '...###....', '....#.....', E, E, E, E, E, E],
    diamond: [E, E, E, '...####...', '..#+####..', '.########.', '..######..', '...####...', '....##....', E, E, E, E, E, E, E],
    sword: [E, '........#.', '.......##.', '......##..', '.....##...', '....##....', '.#.##.....', '..##......', '..+#......', '.+..#.....', E, E, E, E, E, E],
    moon: [E, E, '...###....', '..##......', '.##.......', '.##.......', '.##.......', '..##......', '...###....', E, E, E, E, E, E, E],
    skull: [E, E, '..######..', '.########.', '.#++##++#.', '.#++##++#.', '.########.', '..##..##..', '..#.##.#..', E, E, E, E, E, E, E],
    stripes: [E, E, E, E, '##########', '++++++++++', E, E, '##########', '++++++++++', E, E, E, E, E, E],
    vl: [E, E, '.#...#.+..', '.#...#.+..', '.#...#.+..', '.#...#.+..', '..#.#..+..', '..#.#..+..', '..#.#..+..', '...#...++.', E, E, E, E, E, E],
};

/** Admin panelindeki amblem seçenekleri (anahtar → Türkçe adı). */
const EMBLEM_NAMES = {
    none: 'Yok', vl: 'vulu logosu (VL)', v: 'V', crown: 'Taç', trophy: 'Kupa', one: 'Bir (1)', star: 'Yıldız', flame: 'Alev',
    heart: 'Kalp', diamond: 'Elmas', sword: 'Kılıç', moon: 'Ay', skull: 'Kafatası', stripes: 'Şeritler',
};

/** Varsayılan katalog: ilk açılışta (ya da eksikse) veritabanına yazılır. */
const CATALOG = [
    { key: 'kurucu', name: 'Kurucu', earn: 'vulu\'yu ilk günlerde kuranlara verildi.', order: 1,
        design: { base: '#7a1420', edge: '#e8b64c', emblem: 'v', ink: '#e8b64c', ink2: '#ffffff' } },
    { key: 'sezon-1', name: 'Sezon 1', earn: 'Sezon 1 görevlerinin hepsini bitir ya da sezon seviyesi 10\'a ulaş.', order: 2,
        design: { base: '#2a1650', edge: '#9d7bff', emblem: 'one', ink: '#d7c8ff', ink2: '#ffffff' } },
    { key: 'haftalik-sampiyon', name: 'Haftanın Şampiyonu', earn: 'Haftalık liderlik tablosunda bir dalda birinci ol.', order: 3,
        design: { base: '#0f3d4a', edge: '#4fd1c5', emblem: 'trophy', ink: '#f6d55c', ink2: '#ffffff' } },
    { key: 'etkinlik-birincisi', name: 'Etkinlik Birincisi', earn: 'Bir vulu etkinliğini birincilikle bitir.', order: 4,
        design: { base: '#6b4a00', edge: '#ffe08a', emblem: 'crown', ink: '#fff2c2', ink2: '#c0392b' } },
    { key: 'mesale', name: 'Meşale', earn: 'vulu etkinliklerine katılanlara verilir.', order: 5,
        design: { base: '#2b1408', edge: '#ff7a1a', emblem: 'flame', ink: '#ff9a3c', ink2: '#ffe08a' } },
    { key: 'yildiz', name: 'Yıldız', earn: 'Topluluğa büyük katkısı olanlara admin verir.', order: 6,
        design: { base: '#101a3a', edge: '#8fb6ff', emblem: 'star', ink: '#ffffff', ink2: '#8fb6ff' } },
    // Konseptler (hazır çizim): vulu logosu ve tema renkleri
    { key: 'vulu', name: 'vulu', earn: 'vulu\'nun kendi pelerini: logosu, Meşale renkleriyle.', order: 7, art: 'vulu' },
    { key: 'ufkun-obur-ucu', name: 'Ufkun Öbür Ucu', earn: 'Ufkun öbür ucu temasının neon gün batımı.', order: 8, art: 'ufuk' },
    { key: 'derin-karanlik', name: 'Derin Karanlık', earn: 'Derin Karanlık temasının sculk damarları.', order: 9, art: 'derin' },
    { key: 'kozler', name: 'Közler', earn: 'Meşale temasının közleri ve kıvılcımları.', order: 10, art: 'kozler' },
    { key: 'vulu-admin', name: 'vulu Admin', earn: 'Yalnızca vulu adminlerine özel.', order: 11, art: 'admin', adminOnly: true },
];

/** Desenden 64×32 PNG dokusu (pelerin + elytra bölgesi). */
function drawCape(def) {
    const png = new PNG({ width: 64, height: 32 });
    const set = (x, y, [r, g, b]) => { const o = (y * 64 + x) * 4; png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255; };
    const base = hex(def.base), edge = hex(def.edge), ink = hex(def.ink), ink2 = hex(def.ink2);
    const shadeOf = (c, k) => c.map(v => Math.max(0, Math.min(255, Math.round(v * k))));
    const emblem = EMBLEMS[def.emblem] || EMBLEMS.none;

    // Yüz: 10×16; kenarlık, aşağı doğru hafif koyulaşan zemin, amblem
    const face = (ox, oy) => {
        for (let y = 0; y < 16; y++) for (let x = 0; x < 10; x++) {
            const border = x === 0 || x === 9 || y === 15;
            let c = border ? edge : shadeOf(base, 1.08 - y * 0.018);
            const e = emblem[y][x];
            if (e === '#') c = ink; else if (e === '+') c = ink2;
            set(ox + x, oy + y, c);
        }
    };
    face(1, 1);    // dış yüz (oyuncunun sırtında görünen)
    face(12, 1);   // iç yüz
    for (let y = 0; y < 16; y++) { set(0, 1 + y, edge); set(11, 1 + y, edge); }      // yanlar
    for (let x = 0; x < 10; x++) { set(1 + x, 0, edge); set(11 + x, 0, edge); }      // üst ve alt

    // Elytra (22..45 × 0..21): aynı zemin ve kenar; pelerin takılıyken elytra da bu renkte görünür
    for (let y = 0; y < 22; y++) for (let x = 22; x < 46; x++) {
        const border = x === 22 || x === 45 || y === 0 || y === 21 || x === 34 || x === 35;
        set(x, y, border ? edge : shadeOf(base, 1.05 - y * 0.015));
    }
    return PNG.sync.write(png);
}

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const COLOR = /^#[0-9a-fA-F]{6}$/;
const KEY = /^[a-z0-9-]{1,32}$/;
const bad = message => Object.assign(new Error(message), { status: 400 });

/** Desen: zemin, kenar, amblem ve iki amblem rengi (denetlenmiş). */
function cleanDesign(d) {
    d = d || {};
    const out = {};
    for (const k of ['base', 'edge', 'ink', 'ink2']) {
        if (!COLOR.test(String(d[k] || ''))) throw bad('Renkler #RRGGBB biçiminde olmalı.');
        out[k] = String(d[k]).toLowerCase();
    }
    out.emblem = EMBLEMS[d.emblem] ? d.emblem : 'none';
    return out;
}

/** Yüklenen PNG: 64×32 olmalı (Minecraft pelerin dokusu). */
function checkPng(buffer) {
    let png;
    try { png = PNG.sync.read(buffer); } catch { throw bad('Dosya geçerli bir PNG değil.'); }
    if (png.width !== 64 || png.height !== 32) throw bad(`Pelerin dokusu 64×32 piksel olmalı (bu ${png.width}×${png.height}).`);
    return buffer;
}

/** Bir pelerin kaydının dokusu: desen ya da hazır çizim kodla çizilir; yüklenen PNG veritabanındadır (null). */
const textureOf = c => (c.design ? drawCape(c.design) : c.art ? drawArt(c.art) : null);

const fromDefault = c => ({ key: c.key, name: c.name, earn: c.earn, order: c.order, design: c.design || null, art: c.art || null, adminOnly: !!c.adminOnly, custom: false });

// Bellekteki katalog (veritabanı okunana kadar varsayılanlar)
let list = [];
let byKey = new Map();
function setList(next) {
    list = next.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'tr'));
    byKey = new Map(list.map(c => [c.key, c]));
}
setList(CATALOG.map(c => { const item = fromDefault(c); item.hash = sha(textureOf(item)); return item; }));

const col = () => require('mongoose').connection.db.collection('capes');
const Skin = () => require('../models/Skin');
const storeTexture = (hash, data) => Skin().updateOne({ hash }, { $setOnInsert: { hash, data } }, { upsert: true });
const toDoc = c => ({ name: c.name, earn: c.earn, order: c.order, design: c.design, art: c.art, adminOnly: c.adminOnly, custom: c.custom, textureHash: c.hash });

/**
 * Katalog veritabanından okunur. Eksik varsayılanlar (ilk açılış ya da yeni konseptler) eklenir; silinmiş
 * varsayılanlar bir daha eklenmesin diye silinenlerin listesi tutulur. Kodla çizilen dokular yeniden yazılır.
 */
async function seed() {
    const removed = new Set(((await col().findOne({ _id: '__removed' })) || {}).keys || []);
    const docs = await col().find({ _id: { $ne: '__removed' } }).toArray();
    const have = new Set(docs.map(d => d._id));
    for (const c of CATALOG) if (!have.has(c.key) && !removed.has(c.key)) {
        const item = fromDefault(c);
        docs.push({ _id: c.key, ...toDoc(item), createdAt: new Date() });
        await col().updateOne({ _id: c.key }, { $setOnInsert: { ...toDoc(item), createdAt: new Date() } }, { upsert: true });
    }
    const items = [];
    for (const d of docs) {
        const item = { key: d._id, name: d.name, earn: d.earn || '', order: d.order || 0, design: d.design || null, art: d.art || null, adminOnly: !!d.adminOnly, custom: !!d.custom, hash: d.textureHash };
        const data = item.custom ? null : textureOf(item);
        if (data) {
            item.hash = sha(data);
            await storeTexture(item.hash, data);
            if (item.hash !== d.textureHash) await col().updateOne({ _id: item.key }, { $set: { textureHash: item.hash } });
        }
        if (item.hash) items.push(item);
    }
    setList(items);
}

const textureHash = key => (byKey.get(key) || {}).hash || null;
const isCapeHash = hash => list.some(c => c.hash === hash);
const exists = key => byKey.has(key);
const isAdminOnly = key => !!(byKey.get(key) || {}).adminOnly;

/** Launcher ve site için katalog (doku adresi dahil). */
function catalog(baseUrl) {
    return list.map(c => ({
        key: c.key, name: c.name, earn: c.earn, order: c.order, adminOnly: c.adminOnly,
        color: c.design ? c.design.base : '#555555', accent: c.design ? c.design.edge : '#999999',
        texture: `${baseUrl}/yggdrasil/textures/${c.hash}`, hash: c.hash,
    }));
}

/** Admin: önizleme dokusu (kaydetmeden). */
function preview({ design, art, png }) {
    if (png) return checkPng(Buffer.from(String(png), 'base64'));
    if (art) return drawArt(art);
    return drawCape(cleanDesign(design));
}

/** Kullanılmayan doku silinir (başka bir pelerin, skin ya da dolap kullanmıyorsa). */
async function dropTexture(hash) {
    if (!hash || isCapeHash(hash)) return;
    const User = require('../models/User');
    if (!(await User.exists({ $or: [{ skinHash: hash }, { 'wardrobe.hash': hash }] }))) await Skin().deleteOne({ hash });
}

/**
 * Admin: pelerin ekler ya da günceller. input: { key, name, earn, order, adminOnly, design? | art? | png? (base64) }.
 * Yeni pelerinde bir doku kaynağı gerekir; güncellemede hiçbiri yoksa doku aynı kalır.
 */
async function save(input, isNew) {
    const key = String(input.key || '').trim().toLowerCase();
    if (!KEY.test(key)) throw bad('Anahtar küçük harf, rakam ve tire olmalı (ör. yaz-etkinligi).');
    const existing = byKey.get(key);
    if (isNew && existing) throw bad('Bu anahtarla bir pelerin zaten var.');
    if (!isNew && !existing) throw Object.assign(new Error('Pelerin bulunamadı.'), { status: 404 });
    const name = String(input.name || '').trim().slice(0, 40);
    if (!name) throw bad('Pelerinin adı boş olamaz.');
    const earn = String(input.earn || '').trim().slice(0, 160);
    const order = Number.isFinite(Number(input.order)) ? Math.max(0, Math.min(9999, Math.round(Number(input.order)))) : (existing ? existing.order : list.length + 1);
    const adminOnly = !!input.adminOnly;

    const item = existing ? { ...existing } : { key, design: null, art: null, custom: false, hash: null };
    Object.assign(item, { name, earn, order, adminOnly });
    let data = null;
    if (input.png) { data = checkPng(Buffer.from(String(input.png), 'base64')); Object.assign(item, { design: null, art: null, custom: true }); }
    else if (input.art) { data = drawArt(String(input.art)); Object.assign(item, { design: null, art: String(input.art), custom: false }); }
    else if (input.design) { const design = cleanDesign(input.design); data = drawCape(design); Object.assign(item, { design, art: null, custom: false }); }
    else if (!existing) throw bad('Bir desen ya da hazır çizim seç, veya 64×32 PNG yükle.');
    if (data) { item.hash = sha(data); await storeTexture(item.hash, data); }

    const old = existing ? existing.hash : null;
    await col().updateOne({ _id: key }, { $set: { ...toDoc(item), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    await col().updateOne({ _id: '__removed' }, { $pull: { keys: key } });
    setList([...list.filter(c => c.key !== key), item]);
    // Adminlere özel olduysa admin olmayanlardan alınır
    if (adminOnly) {
        const User = require('../models/User');
        await User.updateMany({ isAdmin: { $ne: true }, 'capes.key': key }, { $pull: { capes: { key } } });
        await User.updateMany({ isAdmin: { $ne: true }, capeKey: key }, { $set: { capeKey: '' } });
    }
    if (old && old !== item.hash) await dropTexture(old);
    return item;
}

/** Admin: pelerini siler; sahiplerinden alınır, takanlarda çıkarılır. Sezon/haftalık ödülüyse önce orası değişmeli. */
async function remove(key) {
    const item = byKey.get(key);
    if (!item) throw Object.assign(new Error('Pelerin bulunamadı.'), { status: 404 });
    const config = require('./progressConfig').get();
    const season = config.seasons.find(s => s.cape === key);
    if (season) throw bad(`Bu pelerin ${season.name} ödülü. Önce İlerleme sekmesinden sezonun pelerinini değiştir.`);
    if (config.weekly.cape === key) throw bad('Bu pelerin haftalık liderlik ödülü. Önce İlerleme sekmesinden değiştir.');
    const User = require('../models/User');
    await User.updateMany({ 'capes.key': key }, { $pull: { capes: { key } } });
    await User.updateMany({ capeKey: key }, { $set: { capeKey: '' } });
    await col().deleteOne({ _id: key });
    if (CATALOG.some(c => c.key === key)) await col().updateOne({ _id: '__removed' }, { $addToSet: { keys: key } }, { upsert: true });
    setList(list.filter(c => c.key !== key));
    await dropTexture(item.hash);
}

/** Admin: pelerinin sahipleri. */
async function owners(key) {
    const User = require('../models/User');
    const users = await User.find({ 'capes.key': key }).select('username capes capeKey avatarVersion').lean();
    return users.map(u => {
        const c = u.capes.find(x => x.key === key) || {};
        return { username: u.username, earnedAt: c.earnedAt || null, note: c.note || '', worn: u.capeKey === key, avatarVersion: u.avatarVersion || 0 };
    }).sort((a, b) => a.username.localeCompare(b.username, 'tr'));
}

/** Admin: her pelerinin kaç kişide olduğu. */
async function ownerCounts() {
    const User = require('../models/User');
    const rows = await User.aggregate([{ $unwind: '$capes' }, { $group: { _id: '$capes.key', count: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map(r => [r._id, r.count]));
}

/** Admin paneli için tam liste (desen dahil). */
const adminList = () => list.map(c => ({ ...c }));

/** Kullanıcının bu pelerini var mı (adminlere özel pelerin adminlerde kendiliğinden vardır). */
function owns(user, key) {
    const c = byKey.get(key);
    if (!c) return false;
    if (c.adminOnly) return !!user.isAdmin;
    return (user.capes || []).some(x => x.key === key);
}

/** Kullanıcıya pelerin verir (zaten varsa dokunmaz). Dönen: yeni verildiyse true. */
async function grant(User, username, key, note = '') {
    if (!byKey.has(key)) throw bad('Böyle bir pelerin yok.');
    if (isAdminOnly(key)) throw bad('Bu pelerin adminlere özel; adminlerde kendiliğinden var, başkasına verilemez.');
    const r = await User.updateOne({ username, 'capes.key': { $ne: key } },
        { $push: { capes: { key, earnedAt: new Date(), note: String(note).slice(0, 120) } } });
    return r.modifiedCount > 0;
}

async function revoke(User, username, key) {
    await User.updateOne({ username }, { $pull: { capes: { key } } });
    await User.updateOne({ username, capeKey: key }, { $set: { capeKey: '' } });
}

module.exports = {
    CATALOG, EMBLEMS, EMBLEM_NAMES, ART_NAMES, drawCape, seed, textureHash, isCapeHash, exists, isAdminOnly, catalog,
    grant, revoke, owns, preview, save, remove, owners, ownerCounts, adminList,
};
