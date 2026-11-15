const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const nbt = require('../lib/worldmap/nbt');
const { drawChunk, unpacker } = require('../lib/worldmap/render');
const { colorOf } = require('../lib/worldmap/colors');

// ── Küçük NBT yazıcı (yalnızca testte) ──
function w(type, value) {
    const parts = [];
    const str = s => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); parts.push(h, b); };
    const body = (t, v) => {
        if (t === 1) parts.push(Buffer.from([v & 255]));
        else if (t === 3) { const b = Buffer.alloc(4); b.writeInt32BE(v); parts.push(b); }
        else if (t === 8) str(v);
        else if (t === 9) { parts.push(Buffer.from([v.type])); const b = Buffer.alloc(4); b.writeInt32BE(v.items.length); parts.push(b); for (const i of v.items) body(v.type, i); }
        else if (t === 10) { for (const [k, [tt, vv]] of Object.entries(v)) { parts.push(Buffer.from([tt])); str(k); body(tt, vv); } parts.push(Buffer.from([0])); }
        else if (t === 12) { const b = Buffer.alloc(4); b.writeInt32BE(v.length); parts.push(b); for (const x of v) { const l = Buffer.alloc(8); l.writeBigInt64BE(x); parts.push(l); } }
    };
    parts.push(Buffer.from([type])); str(''); body(type, value);
    return Buffer.concat(parts);
}

/** Paletli bölüm verisi: index(y,z,x) → palet sırası. */
function packed(fn, bits = 4) {
    const per = Math.floor(64 / bits), longs = new Array(Math.ceil(4096 / per)).fill(0n);
    for (let i = 0; i < 4096; i++) longs[Math.floor(i / per)] |= BigInt(fn(i)) << BigInt((i % per) * bits);
    return longs.map(v => BigInt.asIntN(64, v));
}

test('uzun dizi okuyucu bit sınırlarında doğru', () => {
    const bits = 9, per = 7, vals = Array.from({ length: 256 }, (_, i) => (i * 37) % 512);
    const longs = new Array(Math.ceil(256 / per)).fill(0n);
    vals.forEach((v, i) => { longs[Math.floor(i / per)] |= BigInt(v) << BigInt((i % per) * bits); });
    const buf = Buffer.alloc(longs.length * 8);
    longs.forEach((l, i) => buf.writeBigInt64BE(BigInt.asIntN(64, l), i * 8));
    const get = unpacker({ longs: buf, length: longs.length }, bits);
    vals.forEach((v, i) => assert.strictEqual(get(i), v));
});

test('parça çizimi: en üstteki görünen blok, su derinliği, 26.x palet biçimleri', () => {
    // Bölüm Y=4 (y 64..79): y=64 taş; x<8 için y=65 çim; x>=8 için y=65..67 su; üstü hava
    const palette = ['minecraft:air', { '': 'minecraft:stone' }, { id: 'minecraft:grass_block', properties: { snowy: 'false' } }, 'minecraft:water'];
    const data = packed(i => { const y = i >> 8, x = i & 15; if (y === 0) return 1; if (x < 8) return y === 1 ? 2 : 0; return y <= 3 ? 3 : 0; });
    const chunk = nbt.parse(w(10, {
        Status: [8, 'minecraft:full'], yPos: [3, -4],
        sections: [9, { type: 10, items: [
            { Y: [1, 4], block_states: [10, { palette: [9, { type: 10, items: [] }], data: [12, data] }] },
            { Y: [1, 5], block_states: [10, { palette: [9, { type: 8, items: ['minecraft:air'] }] }] },
        ] }],
    }));
    // Karışık palet (düz metin + bileşik) testte elle verilir
    chunk.sections[0].block_states.palette = palette;
    const rgb = new Uint8Array(512 * 512 * 3), heights = new Int16Array(512 * 512);
    assert.strictEqual(drawChunk(chunk, 0, 0, rgb, heights), true);
    const px = (x, z) => [...rgb.slice((z * 512 + x) * 3, (z * 512 + x) * 3 + 3)];
    assert.deepStrictEqual(px(0, 0), colorOf('minecraft:grass_block'));
    assert.strictEqual(heights[0], 65 - -64 + 1);
    const water = px(10, 3), base = colorOf('minecraft:water');
    assert.ok(water[2] < base[2] && water[2] > base[2] * 0.5, 'su koyulaşmış olmalı');
    assert.strictEqual(heights[3 * 512 + 10], -32768);
});

test('yarım üretilmiş parça çizilmez', () => {
    assert.strictEqual(drawChunk({ Status: 'minecraft:noise', sections: [] }, 0, 0, new Uint8Array(3), new Int16Array(1)), false);
});

test('renk tahmini modların bloklarını da kapsar', () => {
    assert.deepStrictEqual(colorOf('betterend:mossy_glowshroom_leaves'), [70, 115, 40]);
    assert.notDeepStrictEqual(colorOf('techreborn:rubber_log'), [128, 128, 128]);
    assert.deepStrictEqual(colorOf('minecraft:red_wool'), [161, 39, 35]);
});

test('NBT: sıkıştırılmış bileşik', () => {
    const v = nbt.parse(zlib.inflateSync(zlib.deflateSync(w(10, { a: [3, 7], s: [8, 'ş'] }))));
    assert.deepStrictEqual(v, { a: 7, s: 'ş' });
});
