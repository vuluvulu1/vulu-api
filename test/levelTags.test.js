const test = require('node:test');
const assert = require('node:assert');
const mcchat = require('../lib/mcchat');
const settings = require('../lib/progressConfig');
const levelTags = require('../lib/levelTags');

test('sohbet köprüsü takım önekli satırları da okur', () => {
    const before = mcchat.messages().length;
    mcchat.parse('[19:29:01] [Server thread/INFO]: <[Sv 12] vuluvulu> selam');
    mcchat.parse('[19:29:02] [Server thread/INFO]: <KaiKaen> naber');
    mcchat.parse('[19:29:03] [Server thread/INFO]: [Sv 3] KaiKaen left the game');
    mcchat.parse('[19:29:04] [Server thread/INFO]: vuluvulu joined the game');
    const got = mcchat.messages().slice(before).map(m => [m.kind, m.name, m.text]);
    assert.deepStrictEqual(got, [
        ['chat', 'vuluvulu', 'selam'], ['chat', 'KaiKaen', 'naber'], ['leave', 'KaiKaen', ''], ['join', 'vuluvulu', ''],
    ]);
});

test('seviye öneki: takım açılır, oyuncu katılır, değişmeyene komut gitmez, seviye 0 önek almaz', async () => {
    const sent = [];
    const orig = { rcon: mcchat.rcon, enabled: mcchat.enabled, load: settings.load };
    mcchat.enabled = () => true;
    mcchat.rcon = async cmd => { sent.push(cmd); return cmd === 'list' ? 'There are 2 of a max of 20 players online: vuluvulu, KaiKaen' : 'ok'; };
    settings.load = async () => settings.get();
    try {
        levelTags.reset();
        const levels = { vuluvulu: 12, KaiKaen: 0 };
        await levelTags.sync(async names => Object.fromEntries(names.map(n => [n, levels[n]])));
        assert.deepStrictEqual(sent, [
            'list',
            'team add vulu_lv12',
            'team modify vulu_lv12 prefix {"text":"[Sv 12] ","color":"gold"}',
            'team join vulu_lv12 vuluvulu',
        ]);
        sent.length = 0;
        await levelTags.sync(async names => Object.fromEntries(names.map(n => [n, levels[n]])));
        assert.deepStrictEqual(sent, ['list'], 'değişiklik yoksa yalnızca liste sorulur');
        sent.length = 0;
        levels.vuluvulu = 13;
        await levelTags.sync(async names => Object.fromEntries(names.map(n => [n, levels[n]])));
        assert.deepStrictEqual(sent.slice(1), ['team add vulu_lv13', 'team modify vulu_lv13 prefix {"text":"[Sv 13] ","color":"gold"}', 'team join vulu_lv13 vuluvulu']);
    } finally { Object.assign(mcchat, { rcon: orig.rcon, enabled: orig.enabled }); settings.load = orig.load; levelTags.reset(); }
});

test('seviye öneki ayarı denetlenir', () => {
    const base = JSON.parse(JSON.stringify(settings.DEFAULT));
    assert.throws(() => settings.normalize({ ...base, levelTag: { enabled: true, format: '[Seviye] ', color: 'gold' } }), /\{level\}/);
    assert.throws(() => settings.normalize({ ...base, levelTag: { enabled: true, format: '§c{level} ', color: 'gold' } }), /renk kodu/);
    assert.strictEqual(settings.normalize({ ...base, levelTag: { enabled: true, format: 'Lv{level} ', color: 'mor' } }).levelTag.color, 'gold');
    assert.strictEqual(levelTags.prefixText('[Sv {level}] ', 7), '[Sv 7] ');
});
