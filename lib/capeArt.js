// Hazır çizim pelerinler: vulu logosu ve tema renkleriyle elle tasarlanmış dokular (64×32). Desen editörünün
// yapamadığı geçişleri (gün batımı, ızgara, damarlar) burada piksel piksel çizer. Admin panelinde "Hazır çizim" olarak
// görünür; adı/açıklaması değişebilir, istenirse yerine PNG ya da desen konabilir.
'use strict';
const { PNG } = require('pngjs');

const hex = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));
const scale = (c, k) => c.map(v => Math.max(0, Math.min(255, Math.round(v * k))));

// vulu logosu: 10×16 yüze sığan "VL" monogramı. 'V' koyu ahşap, 'L' açık ten
const LOGO = [
    '..........',
    '..........',
    '.V...V.L..',
    '.V...V.L..',
    '.V...V.L..',
    '.V...V.L..',
    '..V.V..L..',
    '..V.V..L..',
    '..V.V..L..',
    '...V...LL.',
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
];

/** Ortak iskelet: yüz (10×16) her iki tarafa, yanlar, üst/alt ve elytra; renkler fonksiyonlardan. */
function render({ face, edge, elytra }) {
    const png = new PNG({ width: 64, height: 32 });
    const set = (x, y, c) => { const o = (y * 64 + x) * 4; png.data[o] = c[0]; png.data[o + 1] = c[1]; png.data[o + 2] = c[2]; png.data[o + 3] = 255; };
    for (let y = 0; y < 16; y++) for (let x = 0; x < 10; x++) { const c = face(x, y); set(1 + x, 1 + y, c); set(12 + x, 1 + y, c); }
    for (let y = 0; y < 16; y++) { set(0, 1 + y, edge(y)); set(11, 1 + y, edge(y)); }
    for (let x = 0; x < 10; x++) { set(1 + x, 0, edge(0)); set(11 + x, 0, edge(15)); }
    for (let y = 0; y < 22; y++) for (let x = 22; x < 46; x++) set(x, y, elytra(x - 22, y));
    return PNG.sync.write(png);
}

/** Basit, her seferinde aynı sonucu veren gürültü (desen tutarlı kalsın, hash değişmesin). */
const noise = (x, y, seed = 1) => { const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453; return n - Math.floor(n); };

const ART = {
    // vulu: logonun kendisi. Koyu kahve zemin, Meşale turuncusu kenar, VL monogramı
    vulu() {
        const bg = hex('#1c140d'), bg2 = hex('#120c08'), edge = hex('#f2a33a'), v = hex('#7a5232'), l = hex('#d9b48a');
        return render({
            face: (x, y) => {
                if (x === 0 || x === 9 || y === 15) return edge;
                const m = LOGO[y][x];
                if (m === 'V') return v;
                if (m === 'L') return l;
                return mix(bg, bg2, y / 15);
            },
            edge: () => edge,
            elytra: (x, y) => (x === 0 || x === 23 || y === 0 || y === 21 || x === 12 || x === 11) ? edge : mix(bg, bg2, y / 21),
        });
    },

    // Ufkun öbür ucu: synthwave gün batımı. Mor gökyüzü, çizgili neon güneş, camgöbeği ızgara
    ufuk() {
        const sky1 = hex('#07000f'), sky2 = hex('#3a0a5e'), pink = hex('#ff2df1'), cyan = hex('#9ff4ff'), sunTop = hex('#ffd36e'), sunBot = hex('#ff3fa4');
        const grid = hex('#1a0433');
        const face = (x, y) => {
            if (x === 0 || x === 9) return pink;
            if (y === 10) return pink;   // ufuk çizgisi
            if (y > 10) {
                // Izgara: iki yatay çizgi, ufka doğru daralan dikeyler
                if (y === 12 || y === 15) return cyan;
                const lanes = y === 11 ? [4, 5] : y === 13 ? [3, 6] : [2, 7];
                return lanes.includes(x) ? cyan : grid;
            }
            // Çizgili güneş (alt yarısı yatay boşluklarla kesik)
            const dx = x - 4.5, dy = y - 6.5;
            if (dx * dx + dy * dy <= 11.5 && !(y === 7 || y === 9)) return mix(sunTop, sunBot, (y - 3) / 6);
            return mix(sky1, sky2, y / 10);
        };
        return render({
            face,
            edge: y => mix(pink, cyan, y / 15),
            elytra: (x, y) => (x === 0 || x === 23 || y === 0) ? pink : y === 15 ? pink : y > 15 ? ((y % 3 === 1 || x % 4 === 0) ? mix(grid, cyan, 0.7) : grid) : mix(sky1, sky2, y / 15),
        });
    },

    // Derin Karanlık: sculk. Neredeyse siyah taş, biyolüminesans camgöbeği damarlar ve parlayan noktalar
    derin() {
        const deep = hex('#030809'), stone = hex('#0b1a1c'), sculk = hex('#2fe6d8'), glow = hex('#8ff7ee');
        const vein = (x, y) => {
            const a = Math.abs(Math.sin(y * 0.9 + x * 0.6) * 4.5 + 4.5 - x) < 0.8;   // kıvrılan ana damar
            const b = y > 9 && Math.abs(Math.sin(y * 1.3) * 1.5 + 2 - (9 - x)) < 0.5;  // ikinci, alttan gelen damar
            return a || b;
        };
        return render({
            face: (x, y) => {
                if (x === 0 || x === 9 || y === 15) return stone;
                if (vein(x, y)) return noise(x, y, 3) > 0.75 ? glow : sculk;
                if (noise(x, y, 7) > 0.96) return glow;
                return mix(stone, deep, 0.35 + noise(x, y, 5) * 0.65);
            },
            edge: y => (y % 5 === 2 ? sculk : stone),
            elytra: (x, y) => vein(x % 10, y % 16) ? sculk : mix(stone, deep, noise(x, y, 9)),
        });
    },

    // Közler: Meşale temasının közleri. Siyahtan aşağıda yanan turuncuya, yukarı uçan kıvılcımlar
    kozler() {
        const black = hex('#0b0a09'), ember = hex('#c9481a'), hot = hex('#f2a33a'), spark = hex('#ffc873');
        return render({
            face: (x, y) => {
                if (x === 0 || x === 9) return hex('#3a1e0e');
                const heat = Math.max(0, (y - 6) / 9) + (noise(x, y, 2) - 0.5) * 0.25;
                // Yukarı uçan birkaç kıvılcım (simetrik değil, göz gibi durmasın)
                if ((x === 2 && y === 2) || (x === 7 && y === 4) || (x === 4 && y === 6) || (x === 6 && y === 1) || (x === 3 && y === 8)) return spark;
                if (heat > 0.85) return hot;
                return mix(black, ember, heat * 1.1);
            },
            edge: y => mix(hex('#3a1e0e'), hot, y / 15),
            elytra: (x, y) => mix(black, ember, Math.max(0, (y - 8) / 13) + (noise(x, y, 4) - 0.5) * 0.2),
        });
    },

    // Adminlere özel vulu pelerini: gece siyahı, altın kenar ve altın VL, kraliyet kırmızısı şerit
    admin() {
        const night = hex('#0d0a12'), night2 = hex('#05040a'), gold = hex('#e8b64c'), goldHi = hex('#ffe08a'), crimson = hex('#8e1b2b');
        return render({
            face: (x, y) => {
                if (x === 0 || x === 9 || y === 15) return gold;
                if (y === 12 || y === 13) return crimson;
                if (y === 14) return goldHi;
                const m = LOGO[y][x];
                if (m === 'V') return gold;
                if (m === 'L') return goldHi;
                return mix(night, night2, y / 15);
            },
            edge: y => (y % 4 === 0 ? goldHi : gold),
            elytra: (x, y) => (x === 0 || x === 23 || y === 0 || y === 21) ? gold : (y === 17 || y === 18) ? crimson : mix(night, night2, y / 21),
        });
    },
};

/** Hazır çizimin adı (admin panelinde). */
const ART_NAMES = { vulu: 'vulu logosu', ufuk: 'Ufkun öbür ucu', derin: 'Derin Karanlık', kozler: 'Közler', admin: 'Admin (altın VL)' };

function drawArt(key) {
    const f = ART[key];
    if (!f) throw Object.assign(new Error('Bilinmeyen hazır çizim.'), { status: 400 });
    return f();
}

module.exports = { drawArt, ART_NAMES, LOGO };
