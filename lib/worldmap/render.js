#!/usr/bin/env node
// Canlı dünya haritası: sunucunun bölge dosyalarından üstten görünüş (1 piksel = 1 blok) PNG karoları üretir.
//
// Makineyi yormamak için:
//   - Yalnızca son çizimden sonra kaydedilmiş parçalar (chunk) yeniden çizilir; başlıktaki zamanlara bakılır.
//     İlk çizimden sonra bir tur, oyuncuların gezdiği birkaç bölgeyle sınırlı kalır.
//   - Sınırlı alan: --radius (blok, 0,0 merkezli) dışındaki bölgelere hiç bakılmaz.
//   - Süre sınırı: --max-seconds dolunca iş yarıda bırakılır, kalan bir sonraki turda devam eder.
//   - Her bölgeden sonra --pause-ms kadar beklenir (işlemci boşa çıkar).
//   - Zamanlayıcı 2 dakikada bir çalıştırır; değişiklik yoksa tur 1 saniyenin altında biter.
//   - systemd birimi düşük öncelikle (Nice=19, IOSchedulingClass=idle, CPUQuota, MemoryMax) çalıştırır: deploy/worldmap.service
//
// Kullanım: node render.js --world <dünya klasörü> --out <karo klasörü> [--dim overworld] [--radius 4096]
//                          [--max-seconds 240] [--pause-ms 150]
//
// Çıktı: <out>/<dim>/0/r.X.Z.png (512 px, bir bölge), <out>/<dim>/1..3/… (uzaklaştırılmış: 2, 4, 8 bölge bir karoda),
//        <out>/<dim>/heights/r.X.Z.bin.gz (gölgelendirme için yükseklikler), <out>/<dim>/state.json, <out>/<dim>/index.json
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PNG } = require('pngjs');
const { readHeader, readChunk } = require('./region');
const { colorOf, INVISIBLE } = require('./colors');

const DIMS = { overworld: 'minecraft/overworld', the_nether: 'minecraft/the_nether', the_end: 'minecraft/the_end' };
const ZOOMS = 3;

function args(argv) {
    const o = { dim: 'overworld', radius: 4096, maxSeconds: 240, pauseMs: 150 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        if (k === '--world') o.world = v, i++;
        else if (k === '--out') o.out = v, i++;
        else if (k === '--dim') o.dim = v, i++;
        else if (k === '--radius') o.radius = Number(v), i++;
        else if (k === '--max-seconds') o.maxSeconds = Number(v), i++;
        else if (k === '--pause-ms') o.pauseMs = Number(v), i++;
        else if (k === '--only') o.only = v, i++;   // tek bölge (ölçüm için): "0,0"
    }
    if (!o.world || !o.out || !DIMS[o.dim]) throw new Error('Kullanım: render.js --world <klasör> --out <klasör> [--dim overworld]');
    return o;
}

// ── Sıkıştırılmış uzun dizilerden değer okuma (1.16+: değerler iki uzun arasında bölünmez) ──
function unpacker(packed, bits) {
    const buf = packed.longs, perLong = Math.floor(64 / bits), mask = (1 << bits) - 1;
    return i => {
        const li = Math.floor(i / perLong), off = (i - li * perLong) * bits, base = li * 8;
        if (base + 8 > buf.length) return 0;
        const hi = buf.readUInt32BE(base), lo = buf.readUInt32BE(base + 4);
        if (off + bits <= 32) return (lo >>> off) & mask;
        if (off >= 32) return (hi >>> (off - 32)) & mask;
        return ((lo >>> off) | (hi << (32 - off))) & mask;
    };
}

/**
 * Palet girişinin blok adı. 26.x'te özelliksiz bloklar düz metin ("minecraft:stone"), özellikliler
 * { id, properties }; liste karışık olunca düz metinler { "": "minecraft:stone" } diye sarılır. Eski sürümler { Name, Properties }.
 */
function blockName(p) {
    if (typeof p === 'string') return p;
    return (p && (p[''] || p.id || p.Name)) || 'minecraft:air';
}

/** Parçanın bölümleri (16 blok yüksekliğinde): Y → blok okuyucu. */
function sectionsOf(chunk) {
    const map = new Map();
    for (const s of chunk.sections || chunk.Sections || []) {
        const states = s.block_states;
        if (!states || !Array.isArray(states.palette) || states.palette.length === 0) continue;
        const palette = states.palette.map(blockName);
        if (palette.length === 1 || !states.data) { const f = () => palette[0]; f.single = palette[0]; map.set(s.Y, f); continue; }
        const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
        const get = unpacker(states.data, bits);
        map.set(s.Y, i => palette[get(i)] || 'minecraft:air');
    }
    return map;
}

/** Bir parçayı çizer: 16×16 renk (gölgesiz) ve yükseklik. Çizilemezse false. */
function drawChunk(chunk, cx, cz, rgb, heights) {
    const status = String(chunk.Status || '');
    if (status && !/full$/.test(status)) return false;   // henüz tamamlanmamış (üretimi yarım) parça
    const minY = (typeof chunk.yPos === 'number' ? chunk.yPos : -4) * 16;
    const sections = sectionsOf(chunk);
    if (sections.size === 0) return false;
    // Yüzey yukarıdan taranarak bulunur (kayıtlı yükseklik haritaları sürümden sürüme farklı); tamamen hava olan
    // bölümler atlanır, böylece tarama yalnızca en üstteki dolu bölümden başlar
    let top = -Infinity;
    for (const [sy, get] of sections) if (sy > top && !(get.single && INVISIBLE.has(get.single))) top = sy;
    if (top === -Infinity) return false;
    const startY = top * 16 + 15;

    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        let y = startY;
        let name = 'minecraft:air', water = 0;
        for (; y >= minY; y--) {
            const s = sections.get(y >> 4);
            const n = s ? s(((y & 15) << 8) | (z << 4) | x) : 'minecraft:air';
            if (INVISIBLE.has(n)) continue;
            if (n === 'minecraft:water' || n === 'minecraft:bubble_column' || n === 'minecraft:seagrass' || n === 'minecraft:tall_seagrass' || n === 'minecraft:kelp' || n === 'minecraft:kelp_plant') {
                if (water === 0) name = 'minecraft:water';
                water++;
                if (water >= 12) break;
                continue;
            }
            if (water === 0) name = n;
            break;
        }
        if (y < minY) y = minY;
        const px = (cz * 16 + z) * 512 + cx * 16 + x;
        let c = colorOf(name);
        if (water > 0) {
            // Su: derinleştikçe koyulaşır
            const k = Math.max(0.55, 1 - water * 0.04);
            c = [c[0] * k, c[1] * k, c[2] * k];
        }
        rgb[px * 3] = c[0]; rgb[px * 3 + 1] = c[1]; rgb[px * 3 + 2] = c[2];
        heights[px] = water > 0 ? -32768 : (y - minY + 1);   // su düz çizilir (gölgesiz)
    }
    return true;
}

/** Kuzeydeki komşuya göre gölgelendirme (haritalardaki gibi): yokuş yukarı açık, aşağı koyu. */
function shade(rgb, heights, png, rows) {
    for (const [z0, z1, x0, x1] of rows) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
        const i = z * 512 + x, h = heights[i];
        let k = 1;
        if (h !== -32768 && z > 0) {
            const n = heights[i - 512];
            if (n !== -32768 && n !== -32767) k = h > n ? 1.12 : h < n ? 0.82 : 1;
        }
        const o = i * 4;
        if (h === -32767) { png.data[o + 3] = 0; continue; }   // çizilmemiş
        png.data[o] = Math.min(255, rgb[i * 3] * k);
        png.data[o + 1] = Math.min(255, rgb[i * 3 + 1] * k);
        png.data[o + 2] = Math.min(255, rgb[i * 3 + 2] * k);
        png.data[o + 3] = 255;
    }
}

function readPng(file) {
    try { return PNG.sync.read(fs.readFileSync(file)); } catch { return null; }
}

function writeAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

function writePng(file, png) {
    writeAtomic(file, PNG.sync.write(png, { colorType: 6, deflateLevel: 6 }));
}

/** Bir bölgeyi çizer; yalnızca zamanı değişmiş parçalar. Dönen: çizilen parça sayısı (0 = değişiklik yok, -1 = durum değişti ama çizim yok). */
function renderRegion(file, rx, rz, out, state) {
    const key = `${rx},${rz}`;
    const prev = state.regions[key] || {};
    const fd = fs.openSync(file, 'r');
    try {
        const header = readHeader(fd);
        if (!header) return 0;
        const changed = [];
        for (let i = 0; i < 1024; i++) {
            const t = header[i].time;
            if (t && header[i].offset && (prev.t ? prev.t[i] !== t : true)) changed.push(i);
        }
        if (changed.length === 0) return 0;

        const tile = path.join(out, '0', `r.${rx}.${rz}.png`);
        const hFile = path.join(out, 'heights', `r.${rx}.${rz}.bin.gz`);
        let png = prev.t ? readPng(tile) : null;
        let heights;
        try { heights = prev.t ? new Int16Array(new Uint8Array(zlib.gunzipSync(fs.readFileSync(hFile))).buffer) : null; } catch { heights = null; }
        if (!png || !heights || heights.length !== 512 * 512) {
            png = new PNG({ width: 512, height: 512 });
            heights = new Int16Array(512 * 512).fill(-32767);
            changed.length = 0;
            for (let i = 0; i < 1024; i++) if (header[i].time && header[i].offset) changed.push(i);
        }
        const rgb = new Uint8Array(512 * 512 * 3);
        const times = prev.t ? prev.t.slice() : new Array(1024).fill(0);
        const rows = [];
        let drawn = 0;
        for (const i of changed) {
            const cx = i & 31, cz = i >> 5;
            const chunk = readChunk(fd, header[i]);
            if (!chunk) continue;   // okunamadı: zamanı kaydedilmez, sonra yeniden denenir
            const root = chunk.Level || chunk;
            if (drawChunk(root, cx, cz, rgb, heights)) { rows.push([cz * 16, cz * 16 + 16, cx * 16, cx * 16 + 16]); drawn++; }
            times[i] = header[i].time;
        }
        if (drawn > 0) {
            shade(rgb, heights, png, rows);
            writePng(tile, png);
            writeAtomic(hFile, zlib.gzipSync(Buffer.from(heights.buffer), { level: 6 }));
        }
        state.regions[key] = { t: times, at: Date.now(), drawnAt: drawn > 0 ? Date.now() : (prev.drawnAt || prev.at || Date.now()) };
        return drawn > 0 ? drawn : -1;   // -1: zamanlar güncellendi ama çizilecek bir şey çıkmadı
    } finally { fs.closeSync(fd); }
}

/** Uzaklaştırılmış karo: 2×2 alt karonun ortalaması. */
function buildZoom(out, level, tx, tz) {
    const png = new PNG({ width: 512, height: 512 });
    let any = false;
    for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
        const child = readPng(path.join(out, String(level - 1), `r.${tx * 2 + dx}.${tz * 2 + dz}.png`));
        if (!child) continue;
        any = true;
        for (let z = 0; z < 256; z++) for (let x = 0; x < 256; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let k = 0; k < 4; k++) {
                const o = ((z * 2 + (k >> 1)) * 512 + x * 2 + (k & 1)) * 4;
                if (child.data[o + 3]) { r += child.data[o]; g += child.data[o + 1]; b += child.data[o + 2]; a++; }
            }
            const o = ((dz * 256 + z) * 512 + dx * 256 + x) * 4;
            if (a) { png.data[o] = r / a; png.data[o + 1] = g / a; png.data[o + 2] = b / a; png.data[o + 3] = 255; }
        }
    }
    const file = path.join(out, String(level), `r.${tx}.${tz}.png`);
    if (any) writePng(file, png); else fs.rmSync(file, { force: true });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    const o = args(process.argv);
    const regionDir = path.join(o.world, 'dimensions', DIMS[o.dim], 'region');
    const legacy = path.join(o.world, o.dim === 'overworld' ? 'region' : o.dim === 'the_nether' ? 'DIM-1/region' : 'DIM1/region');
    const dir = fs.existsSync(regionDir) ? regionDir : legacy;
    const out = path.join(o.out, o.dim);
    fs.mkdirSync(out, { recursive: true });
    const stateFile = path.join(out, 'state.json');
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = { regions: {} }; }
    state.regions = state.regions || {};

    const limit = Math.ceil(o.radius / 512);
    let files = fs.readdirSync(dir).map(f => /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f)).filter(Boolean)
        .map(m => ({ file: path.join(dir, m[0]), rx: +m[1], rz: +m[2] }))
        .filter(r => Math.abs(r.rx + 0.5) <= limit && Math.abs(r.rz + 0.5) <= limit);
    if (o.only) { const [x, z] = o.only.split(',').map(Number); files = files.filter(r => r.rx === x && r.rz === z); }
    // Merkeze yakın bölgeler önce (ilk çizim yarıda kalsa da oyuncuların olduğu yer hazır olur)
    files.sort((a, b) => (a.rx * a.rx + a.rz * a.rz) - (b.rx * b.rx + b.rz * b.rz));

    const started = Date.now();
    const dirty = new Set();
    let chunks = 0, regions = 0, unfinished = false, touched = false;
    for (const r of files) {
        if ((Date.now() - started) / 1000 > o.maxSeconds) { unfinished = true; break; }
        let n = 0;
        try { n = renderRegion(r.file, r.rx, r.rz, out, state); }
        catch (err) { console.error(`r.${r.rx}.${r.rz}: ${err.message}`); }
        if (n > 0) { chunks += n; regions++; dirty.add(`${r.rx},${r.rz}`); await sleep(o.pauseMs); }
        else if (n < 0) touched = true;
    }
    // Uzaklaştırılmış karolar: yalnızca değişen bölgelerin üstündekiler
    let level = dirty;
    for (let z = 1; z <= ZOOMS; z++) {
        const next = new Set([...level].map(k => k.split(',').map(Number)).map(([x, y]) => `${Math.floor(x / 2)},${Math.floor(y / 2)}`));
        for (const k of next) { const [x, y] = k.split(',').map(Number); buildZoom(out, z, x, y); }
        level = next;
    }
    // Durum dosyası (bölge başına 1024 zaman) yalnızca bir şey değiştiyse yazılır; boş turlar diske dokunmaz
    if (dirty.size > 0 || touched) writeAtomic(stateFile, JSON.stringify(state));
    // Çizilmiş bölgeler ve son değişme zamanları: launcher yalnızca değişen karoları yeniden indirir
    const tiles = Object.fromEntries(Object.entries(state.regions)
        .filter(([k]) => fs.existsSync(path.join(out, '0', `r.${k.replace(',', '.')}.png`)))
        .map(([k, v]) => [k, v.drawnAt || v.at || 0]));
    writeAtomic(path.join(out, 'index.json'), JSON.stringify({ updatedAt: new Date().toISOString(), zooms: ZOOMS, regions: tiles, radius: o.radius }));
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`Harita (${o.dim}): ${regions} bölge, ${chunks} parça çizildi, ${secs} sn${unfinished ? ' (süre doldu, kalan sonraki turda)' : ''}.`);
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });

module.exports = { drawChunk, unpacker };
