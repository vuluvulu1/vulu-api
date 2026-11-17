const test = require('node:test');
const assert = require('node:assert');
const { PNG } = require('pngjs');
const capes = require('../lib/capes');

test('her pelerin 64×32 PNG ve dış yüzü dolu', () => {
    for (const def of capes.CATALOG) {
        const png = PNG.sync.read(def.design ? capes.drawCape(def.design) : require('../lib/capeArt').drawArt(def.art));
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
    for (const s of require('../lib/progressConfig').DEFAULT.seasons) assert.ok(capes.exists(s.cape));
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

test('adminlere özel pelerin: yalnızca adminde var, verilemez, oyunda yalnızca adminde görünür', async () => {
    assert.ok(capes.isAdminOnly('vulu-admin'));
    assert.strictEqual(capes.owns({ isAdmin: true, capes: [] }, 'vulu-admin'), true);
    assert.strictEqual(capes.owns({ isAdmin: false, capes: [{ key: 'vulu-admin' }] }, 'vulu-admin'), false);
    await assert.rejects(capes.grant({}, 'x', 'vulu-admin'), /adminlere özel/);
    const { profileOf } = require('../lib/yggdrasil');
    const tex = async user => JSON.parse(Buffer.from((await profileOf({ username: 'a', skinHash: '', ...user }, 'https://x', false)).properties[0].value, 'base64').toString()).textures;
    assert.ok((await tex({ capeKey: 'vulu-admin', isAdmin: true })).CAPE);
    assert.strictEqual((await tex({ capeKey: 'vulu-admin', isAdmin: false })).CAPE, undefined);
});

test('önizleme: desen, hazır çizim ve PNG; hatalı PNG reddedilir', () => {
    const { PNG } = require('pngjs');
    const size = b => { const p = PNG.sync.read(b); return `${p.width}x${p.height}`; };
    assert.strictEqual(size(capes.preview({ design: { base: '#112233', edge: '#ffffff', emblem: 'vl', ink: '#ff0000', ink2: '#00ff00' } })), '64x32');
    for (const art of Object.keys(capes.ART_NAMES)) assert.strictEqual(size(capes.preview({ art })), '64x32');
    assert.throws(() => capes.preview({ design: { base: 'kırmızı' } }), /Renkler/);
    const wrong = PNG.sync.write(new PNG({ width: 64, height: 64 })).toString('base64');
    assert.throws(() => capes.preview({ png: wrong }), /64×32/);
    assert.throws(() => capes.preview({ png: PNG.sync.write(new PNG({ width: 96, height: 48 })).toString('base64') }), /katı/);
    // HD: 64×32'nin tam katları kabul edilir
    for (const k of [2, 4, 8]) assert.strictEqual(size(capes.preview({ png: PNG.sync.write(new PNG({ width: 64 * k, height: 32 * k })).toString('base64') })), `${64 * k}x${32 * k}`);
    assert.throws(() => capes.preview({ png: Buffer.from('nope').toString('base64') }), /PNG/);
});
