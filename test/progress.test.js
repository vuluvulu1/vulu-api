const test = require('node:test');
const assert = require('node:assert');
const p = require('../lib/progress');

test('istatistik dosyasından sayılar', () => {
    const t = p.extract({ stats: {
        'minecraft:custom': { 'minecraft:play_time': 72000, 'minecraft:deaths': 3, 'minecraft:walk_one_cm': 150000, 'minecraft:sprint_one_cm': 50000,
            'minecraft:fall_one_cm': 99999, 'minecraft:fly_one_cm': 99999, 'minecraft:mob_kills': 7 },
        'minecraft:mined': { 'minecraft:diamond_ore': 2, 'minecraft:deepslate_diamond_ore': 5, 'minecraft:stone': 100 },
    } }, 4);
    assert.deepStrictEqual(t, { playTicks: 72000, diamonds: 7, deaths: 3, distanceCm: 200000, mobKills: 7, advancements: 4 });
});

test('başarım sayımı tarifleri saymaz', () => {
    assert.strictEqual(p.countAdvancements({
        'minecraft:story/mine_stone': { done: true }, 'minecraft:recipes/misc/stick': { done: true },
        'minecraft:story/smelt_iron': { done: false }, DataVersion: 4000,
    }), 1);
});

test('seviye eğrisi', () => {
    assert.strictEqual(p.levelOf(0).level, 0);
    assert.strictEqual(p.levelOf(99).level, 0);
    assert.strictEqual(p.levelOf(100).level, 1);
    assert.strictEqual(p.levelOf(299).level, 1);
    assert.strictEqual(p.levelOf(300).level, 2);
    assert.strictEqual(p.levelOf(5500).level, 10);
    const l = p.levelOf(200);
    assert.ok(l.progress > 0.49 && l.progress < 0.51);
    assert.strictEqual(p.xpOf({ playTicks: 1200 * 60, diamonds: 2, advancements: 1, distanceCm: 250000, mobKills: 25 }), 60 + 30 + 25 + 8 + 2);
});

test('hafta Türkiye saatiyle pazartesi başlar', () => {
    // Pazar 23:30 TR = Pazar 20:30 UTC → önceki hafta
    assert.strictEqual(p.weekKey(new Date('2026-11-22T20:30:00Z')), '2026-11-16');
    // Pazartesi 00:30 TR = Pazar 21:30 UTC → yeni hafta
    assert.strictEqual(p.weekKey(new Date('2026-11-22T21:30:00Z')), '2026-11-23');
    assert.strictEqual(p.weekStart(new Date('2026-11-18T12:00:00Z')).toISOString(), '2026-11-15T21:00:00.000Z');
});

test('sıralama: sıfırlar listelenmez, eşitlikte ada göre', () => {
    const rows = [
        { username: 'b', totals: { playTicks: 1200 * 90, diamonds: 0, deaths: 2, distanceCm: 123456, mobKills: 0, advancements: 0 } },
        { username: 'a', totals: { playTicks: 1200 * 5, diamonds: 3, deaths: 2, distanceCm: 50, mobKills: 0, advancements: 0 } },
    ];
    const r = Object.fromEntries(p.rank(rows).map(c => [c.key, c.rows]));
    assert.deepStrictEqual(r.playtime.map(x => x.username), ['b', 'a']);
    assert.strictEqual(r.playtime[0].display, '1 sa 30 dk');
    assert.deepStrictEqual(r.diamonds.map(x => x.username), ['a']);
    assert.deepStrictEqual(r.deaths.map(x => x.username), ['a', 'b']);
    assert.strictEqual(r.distance[0].display, '1,2 km');
});

test('dönem farkı eksiye düşmez', () => {
    assert.deepStrictEqual(p.sub({ playTicks: 10, diamonds: 1, deaths: 0, distanceCm: 5, mobKills: 0, advancements: 0 },
        { playTicks: 4, diamonds: 3 }), { playTicks: 6, diamonds: 0, deaths: 0, distanceCm: 5, mobKills: 0, advancements: 0 });
});

test('sezon 1 tanımlı ve rozetleri katalogda', () => {
    const s = p.currentSeason(new Date('2026-12-01T00:00:00Z'));
    assert.strictEqual(s.key, 's1');
    for (const q of s.quests) assert.ok(p.BADGES.has(`s1-${q.key}`));
    for (const c of p.CATEGORIES) assert.ok(p.BADGES.has(c.badge));
    assert.strictEqual(p.currentSeason(new Date('2030-01-01')), null);
});
