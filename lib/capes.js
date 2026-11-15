// vulu Pelerinleri: satılmaz; oynayarak, sezon görevleriyle ve etkinlik kazanarak alınır.
//
// Oyunda görünme yolu: launcher oyunu authlib-injector ile vulu'nun Yggdrasil API'sine bağlar; vulu-resmi sunucusu da
// aynı ajanla çalışır (online-mode=true). Oyuncunun profilindeki imzalı "textures" özelliğine SKIN'in yanına CAPE
// eklenince, sunucu bu özelliği herkese iletir ve oyunun kendisi pelerini çizer (tek oyunculuda ve LAN'da da). İstemciye
// ya da sunucuya mod gerekmez; Mojang pelerinleriyle aynı yol.
//
// Pelerin dokuları burada kodla çizilir (64×32 PNG) ve skinlerle aynı koleksiyonda, içeriklerinin SHA-256'sıyla saklanır:
// oyun /yggdrasil/textures/<hash> adresinden indirir ve hash'e göre önbelleğe alır.
'use strict';
const crypto = require('crypto');
const { PNG } = require('pngjs');

const hex = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

// Pelerinin dış yüzü 10×16 piksel. Amblemler: '#' = amblem rengi, '+' = ikinci renk, '.' = boş
const EMBLEMS = {
    v: ['..........', '..........', '..........', '..#....#..', '..#....#..', '..##..##..', '...#..#...', '...####...',
        '....##....', '..........', '..........', '..........', '..........', '..........', '..........', '..........'],
    crown: ['..........', '..........', '..........', '..#..#..#.', '..#.###.#.', '..#######.', '..#+###+#.', '..#######.',
        '..........', '..........', '..........', '..........', '..........', '..........', '..........', '..........'],
    trophy: ['..........', '..........', '.########.', '.#.####.#.', '.#.####.#.', '..######..', '...####...', '....##....',
        '....##....', '...####...', '..######..', '..........', '..........', '..........', '..........', '..........'],
    one: ['..........', '..........', '....##....', '...###....', '..####....', '....##....', '....##....', '....##....',
        '....##....', '....##....', '..######..', '..........', '..........', '..........', '..........', '..........'],
    star: ['..........', '..........', '....##....', '....##....', '.########.', '..######..', '...####...', '..##..##..',
        '..#....#..', '..........', '..........', '..........', '..........', '..........', '..........', '..........'],
    flame: ['..........', '..........', '....#.....', '....##....', '...###....', '...####...', '..##+###..', '..#+++##..',
        '..#+++##..', '...####...', '..........', '..........', '..........', '..........', '..........', '..........'],
};

/**
 * Katalog. key kalıcıdır (kullanıcılarda saklanır). earn: nasıl kazanıldığı (launcher ve sitede görünür).
 * grant: 'admin' (admin verir), 'weekly' (haftalık liderlik birincileri), 'season:<anahtar>' (sezon pelerini).
 */
const CATALOG = [
    { key: 'kurucu', name: 'Kurucu', earn: 'vulu\'yu ilk günlerde kuranlara verildi.', grant: 'admin',
        base: '#7a1420', edge: '#e8b64c', emblem: 'v', ink: '#e8b64c', ink2: '#ffffff', order: 1 },
    { key: 'sezon-1', name: 'Sezon 1', earn: 'Sezon 1 görevlerinin hepsini bitir ya da sezon seviyesi 10\'a ulaş.', grant: 'season:s1',
        base: '#2a1650', edge: '#9d7bff', emblem: 'one', ink: '#d7c8ff', ink2: '#ffffff', order: 2 },
    { key: 'haftalik-sampiyon', name: 'Haftanın Şampiyonu', earn: 'Haftalık liderlik tablosunda bir dalda birinci ol.', grant: 'weekly',
        base: '#0f3d4a', edge: '#4fd1c5', emblem: 'trophy', ink: '#f6d55c', ink2: '#ffffff', order: 3 },
    { key: 'etkinlik-birincisi', name: 'Etkinlik Birincisi', earn: 'Bir vulu etkinliğini birincilikle bitir.', grant: 'admin',
        base: '#6b4a00', edge: '#ffe08a', emblem: 'crown', ink: '#fff2c2', ink2: '#c0392b', order: 4 },
    { key: 'mesale', name: 'Meşale', earn: 'vulu etkinliklerine katılanlara verilir.', grant: 'admin',
        base: '#2b1408', edge: '#ff7a1a', emblem: 'flame', ink: '#ff9a3c', ink2: '#ffe08a', order: 5 },
    { key: 'yildiz', name: 'Yıldız', earn: 'Topluluğa büyük katkısı olanlara admin verir.', grant: 'admin',
        base: '#101a3a', edge: '#8fb6ff', emblem: 'star', ink: '#ffffff', ink2: '#8fb6ff', order: 6 },
];

/** Bir pelerinin 64×32 PNG dokusu (pelerin + elytra bölgesi). */
function drawCape(def) {
    const png = new PNG({ width: 64, height: 32 });
    const set = (x, y, [r, g, b], a = 255) => { const o = (y * 64 + x) * 4; png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = a; };
    const base = hex(def.base), edge = hex(def.edge), ink = hex(def.ink), ink2 = hex(def.ink2);
    const shadeOf = (c, k) => c.map(v => Math.max(0, Math.min(255, Math.round(v * k))));
    const emblem = EMBLEMS[def.emblem] || EMBLEMS.v;

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

const byKey = new Map(CATALOG.map(c => [c.key, c]));
const textures = new Map();   // key → { hash, data }
for (const def of CATALOG) {
    const data = drawCape(def);
    textures.set(def.key, { hash: crypto.createHash('sha256').update(data).digest('hex'), data });
}

/** Dokular skinlerle aynı koleksiyona yazılır (yoksa); açılışta bir kez. */
async function seed() {
    const Skin = require('../models/Skin');
    for (const { hash, data } of textures.values())
        await Skin.updateOne({ hash }, { $setOnInsert: { hash, data } }, { upsert: true });
}

const textureHash = key => (textures.get(key) || {}).hash || null;
const isCapeHash = hash => [...textures.values()].some(t => t.hash === hash);
const exists = key => byKey.has(key);

/** Launcher ve site için katalog (doku adresi dahil). */
function catalog(baseUrl) {
    return CATALOG.map(c => ({
        key: c.key, name: c.name, earn: c.earn, grant: c.grant, color: c.base, accent: c.edge, order: c.order,
        texture: `${baseUrl}/yggdrasil/textures/${textureHash(c.key)}`, hash: textureHash(c.key),
    }));
}

/** Kullanıcıya pelerin verir (zaten varsa dokunmaz). Dönen: yeni verildiyse true. */
async function grant(User, username, key, note = '') {
    if (!byKey.has(key)) throw Object.assign(new Error('Böyle bir pelerin yok.'), { status: 400 });
    const r = await User.updateOne({ username, 'capes.key': { $ne: key } },
        { $push: { capes: { key, earnedAt: new Date(), note: String(note).slice(0, 120) } } });
    return r.modifiedCount > 0;
}

async function revoke(User, username, key) {
    await User.updateOne({ username }, { $pull: { capes: { key } } });
    await User.updateOne({ username, capeKey: key }, { $set: { capeKey: '' } });
}

module.exports = { CATALOG, drawCape, seed, textureHash, isCapeHash, exists, catalog, grant, revoke, byKey };
