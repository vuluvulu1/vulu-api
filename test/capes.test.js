const test = require('node:test');
const assert = require('node:assert');
const { PNG } = require('pngjs');
const capes = require('../lib/capes');

test('her pelerin 64×32 PNG ve dış yüzü dolu', () => {
    for (const def of capes.CATALOG) {
        const png = PNG.sync.read(capes.drawCape(def));
        assert.strictEqual(png.width, 64);
        assert.strictEqual(png.height, 32);
        for (let y = 1; y < 17; y++) for (let x = 1; x < 11; x++) assert.strictEqual(png.data[(y * 64 + x) * 4 + 3], 255, `${def.key} ${x},${y}`);
        assert.match(capes.textureHash(def.key), /^[0-9a-f]{64}$/);
        assert.ok(capes.isCapeHash(capes.textureHash(def.key)));
    }
});

test('katalog anahtarları benzersiz ve sezon pelerini var', () => {
    const keys = capes.CATALOG.map(c => c.key);
    assert.strictEqual(new Set(keys).size, keys.length);
    for (const s of require('../lib/progress').SEASONS) assert.ok(capes.exists(s.cape));
    assert.ok(capes.exists('haftalik-sampiyon'));
});

test('Yggdrasil profili takılı pelerini CAPE olarak taşır', async () => {
    const { profileOf } = require('../lib/yggdrasil');
    const p = await profileOf({ username: 'vuluvulu', skinHash: '', capeKey: 'kurucu' }, 'https://x/api', false);
    const textures = JSON.parse(Buffer.from(p.properties[0].value, 'base64').toString()).textures;
    assert.strictEqual(textures.CAPE.url, `https://x/api/yggdrasil/textures/${capes.textureHash('kurucu')}`);
    const none = await profileOf({ username: 'vuluvulu', skinHash: '', capeKey: '' }, 'https://x/api', false);
    assert.strictEqual(JSON.parse(Buffer.from(none.properties[0].value, 'base64').toString()).textures.CAPE, undefined);
});
