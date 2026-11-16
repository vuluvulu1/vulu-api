// İlerleme: liderlik tablosu, vulu seviyesi, sezonlar, görevler ve rozetler.
//
// Kaynak: vulu-resmi sunucusunun oyuncu istatistikleri (world/players/stats/<uuid>.json, başarımlar
// world/players/advancements/<uuid>.json). Oyunun kendi tuttuğu sayılar; sunucuya mod gerekmez. Sunucu bunları
// otomatik kayıtta (5 dakikada bir) ve oyuncu çıkınca yazar; API 5 dakikada bir okur.
// Oyuncu kimliği vulu hesabından türetilir (lib/yggdrasil.js offlineUuid), böylece istatistik doğrudan hesaba bağlanır.
//
// Haftalık tablo: her pazartesi 00:00 (Türkiye saati) her oyuncunun toplamı "başlangıç" olarak saklanır; haftanın
// sırası toplam − başlangıç farkıdır. Hafta kapanınca her dalın birincisine rozet ve "Haftanın Şampiyonu" pelerini verilir.
// Sezon: aynı yöntemle sezon başından beri kazanılanlar; sezon seviyesi, görevler ve sezon pelerini buradan.
'use strict';
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const INSTANCE = process.env.MC_STATS_INSTANCE || process.env.MC_CHAT_INSTANCE || '';
const TICK_MS = 5 * 60 * 1000;
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;   // Türkiye: UTC+3, yaz saati yok

// ── İstatistikler ─────────────────────────────────────────────────────────
const DISTANCE_KEYS = ['walk_one_cm', 'sprint_one_cm', 'crouch_one_cm', 'swim_one_cm', 'walk_on_water_one_cm', 'walk_under_water_one_cm',
    'boat_one_cm', 'horse_one_cm', 'minecart_one_cm', 'pig_one_cm', 'strider_one_cm', 'aviate_one_cm', 'climb_one_cm',
    'happy_ghast_one_cm', 'nautilus_one_cm'];

/** Oyunun istatistik dosyasından vulu'nun kullandığı sayılar. */
function extract(stats, advancements = 0) {
    const s = (stats && stats.stats) || {};
    const custom = s['minecraft:custom'] || {}, mined = s['minecraft:mined'] || {}, killed = s['minecraft:killed'] || {};
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    let distanceCm = 0;
    for (const k of DISTANCE_KEYS) distanceCm += num(custom['minecraft:' + k]);
    let mobKills = num(custom['minecraft:mob_kills']);
    if (!mobKills) for (const v of Object.values(killed)) mobKills += num(v);
    return {
        playTicks: num(custom['minecraft:play_time'] ?? custom['minecraft:play_one_minute']),
        diamonds: num(mined['minecraft:diamond_ore']) + num(mined['minecraft:deepslate_diamond_ore']),
        deaths: num(custom['minecraft:deaths']),
        distanceCm,
        mobKills,
        advancements: num(advancements),
    };
}

/** Başarım dosyasında tamamlanmış (tarif olmayan) başarım sayısı. */
function countAdvancements(json) {
    let n = 0;
    for (const [key, value] of Object.entries(json || {}))
        if (value && value.done === true && !key.includes(':recipes/')) n++;
    return n;
}

const ZERO = extract({});
const sub = (a, b) => Object.fromEntries(Object.keys(ZERO).map(k => [k, Math.max(0, (a[k] || 0) - ((b && b[k]) || 0))]));

// ── Ayarlar (admin panelinden düzenlenir: lib/progressConfig.js) ─────────────
const settings = require('./progressConfig');
const cfg = () => settings.get();

// ── Seviye ────────────────────────────────────────────────────────────────
/** XP: varsayılan olarak oynanan her dakika 1, elmas 15, başarım 25, her km 4, 10 yaratık 1 (katsayılar ayardan). */
function xpOf(t, c = cfg()) {
    const x = c.xp;
    return Math.floor(Math.floor((t.playTicks || 0) / 1200) * x.minute + (t.diamonds || 0) * x.diamond + (t.advancements || 0) * x.advancement
        + Math.floor((t.distanceCm || 0) / 100000) * x.km + Math.floor((t.mobKills || 0) / 10) * x.mobs10);
}

/** L. seviye için toplam base·L·(L+1) XP gerekir (varsayılan 50: 1 → 100, 2 → 300, 5 → 1500, 10 → 5500). */
const xpForLevel = (level, base = cfg().levelBase) => base * level * (level + 1);
function levelOf(xp, base = cfg().levelBase) {
    const level = Math.max(0, Math.floor((-1 + Math.sqrt(1 + (4 / base) * Math.max(0, xp))) / 2));
    const from = xpForLevel(level, base), to = xpForLevel(level + 1, base);
    return { level, xp, from, to, progress: (xp - from) / (to - from) };
}

// ── Takvim ────────────────────────────────────────────────────────────────
/** Türkiye saatine göre o haftanın pazartesi 00:00'ı (UTC Date). */
function weekStart(date = new Date()) {
    const local = new Date(date.getTime() + TZ_OFFSET_MS);
    const day = (local.getUTCDay() + 6) % 7;   // pazartesi = 0
    const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day);
    return new Date(monday - TZ_OFFSET_MS);
}
const weekKey = date => new Date(weekStart(date).getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);

// ── Sezonlar ve görevler ───────────────────────────────────────────────────
// Görev ilerlemesi sezon başından beri kazanılanlardan hesaplanır. Her görev bir rozet verir; sezon pelerini
// görevlerin hepsini bitirince ya da sezon seviyesi capeLevel'a ulaşınca (0 = yalnızca görevlerle).
function currentSeason(now = new Date()) {
    return cfg().seasons.find(s => new Date(s.startsAt) <= now && now < new Date(s.endsAt)) || null;
}

/** Görevin ham istatistiği ve hedefi (oyunun birimiyle). */
function questRaw(q) {
    const s = settings.STATS[q.stat];
    return { stat: s.raw, target: q.target * s.scale, scale: s.scale, unit: s.unit };
}

// ── Haftalık dallar ve rozetler ───────────────────────────────────────────
function categories() {
    return cfg().weekly.categories.filter(c => c.enabled).map(c => ({ ...c, ...settings.WEEKLY_STATS[c.key] }));
}

function badgeDef(key) {
    const c = cfg();
    const weekly = c.weekly.categories.find(x => settings.WEEKLY_STATS[x.key].badge === key);
    if (weekly) return { key, name: weekly.badgeName, desc: `Haftalık tabloda "${weekly.name}" dalında birinci.`, icon: weekly.icon };
    const archived = c.badgeArchive[key];
    return archived ? { key, ...archived } : null;
}

function badgeInfo(b) {
    const def = badgeDef(b.key) || { key: b.key, name: b.key, desc: '', icon: '★' };
    return { ...def, count: b.count || 1, earnedAt: b.earnedAt || null };
}

/** Tablodaki sayının okunur hâli. */
function display(unit, value) {
    if (unit === 'time') {
        const minutes = Math.floor(value / 1200), hours = Math.floor(minutes / 60);
        return hours > 0 ? `${hours} sa ${minutes % 60} dk` : `${minutes} dk`;
    }
    if (unit === 'distance') {
        const m = value / 100;
        return m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`;
    }
    return String(value);
}

/** Her dalda sıra (0 olanlar listelenmez). rows: [{ username, totals }] */
function rank(rows, limit = 10) {
    return categories().map(c => ({
        key: c.key, name: c.name, unit: c.unit, icon: c.icon,
        rows: rows.map(r => ({ username: r.username, value: r.totals[c.stat] || 0 }))
            .filter(r => r.value > 0)
            .sort((a, b) => b.value - a.value || a.username.localeCompare(b.username))
            .slice(0, limit)
            .map((r, i) => ({ rank: i + 1, username: r.username, value: r.value, display: display(c.unit, r.value) })),
    }));
}

// ── Veritabanı ────────────────────────────────────────────────────────────
const col = name => mongoose.connection.db.collection(name);
// player_stats:  { _id: uuid, username, totals, updatedAt }
// stat_baselines: { _id: "<dönem>:<uuid>", period: "week:2026-11-16" | "season:s1", uuid, username, totals, at }
// leaderboard_weeks: { _id: "2026-11-16", categories, closedAt }
// progress_state: { _id: 'state', week }

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Sunucudaki bütün oyuncuların toplamları: uuid (tiresiz) → totals. */
function readServerStats(instance = INSTANCE) {
    const world = path.join(instance, 'world');
    const dirs = [path.join(world, 'players'), world];   // 26.x: world/players/stats; eskiler: world/stats
    const out = new Map();
    for (const base of dirs) {
        const statsDir = path.join(base, 'stats');
        let files;
        try { files = fs.readdirSync(statsDir).filter(f => /^[0-9a-f-]{36}\.json$/i.test(f)); } catch { continue; }
        for (const f of files) {
            const uuid = f.slice(0, 36).replace(/-/g, '').toLowerCase();
            if (out.has(uuid)) continue;
            const stats = readJson(path.join(statsDir, f));
            if (!stats) continue;
            const adv = countAdvancements(readJson(path.join(base, 'advancements', f)));
            out.set(uuid, extract(stats, adv));
        }
        if (out.size) break;
    }
    return out;
}

/** vulu hesapları: uuid → kullanıcı adı. */
async function accountsByUuid() {
    const { offlineUuid } = require('./yggdrasil');
    const User = require('../models/User');
    const users = await User.find({ isActive: { $ne: false } }).select('username').lean();
    return new Map(users.map(u => [offlineUuid(u.username), u.username]));
}

async function giveBadge(username, key) {
    const User = require('../models/User');
    const r = await User.updateOne({ username, 'badges.key': key }, { $inc: { 'badges.$.count': 1 }, $set: { 'badges.$.earnedAt': new Date() } });
    if (r.matchedCount === 0) await User.updateOne({ username }, { $push: { badges: { key, count: 1, earnedAt: new Date() } } });
}

async function giveBadgeOnce(username, key) {
    const User = require('../models/User');
    await User.updateOne({ username, 'badges.key': { $ne: key } }, { $push: { badges: { key, count: 1, earnedAt: new Date() } } });
}

/**
 * Dönemin başlangıç toplamları (yoksa). Daha önce görülmüş oyuncunun başlangıcı şu anki toplamıdır (yeni hafta/sezon
 * sıfırdan başlar); ilk kez görülen oyuncununki sıfır, böylece ilk oturumu da döneme sayılır.
 */
async function ensureBaselines(period, players, known) {
    const ops = players.map(p => ({
        updateOne: {
            filter: { _id: `${period}:${p.uuid}` },
            update: { $setOnInsert: { period, uuid: p.uuid, username: p.username, totals: known.has(p.uuid) ? p.totals : ZERO, at: new Date() } },
            upsert: true,
        },
    }));
    if (ops.length) await col('stat_baselines').bulkWrite(ops, { ordered: false });
}

/** Dönem başından beri kazanılanlar: [{ uuid, username, totals }] */
async function periodRows(period) {
    const [current, baselines] = await Promise.all([
        col('player_stats').find({}).toArray(),
        col('stat_baselines').find({ period }).toArray(),
    ]);
    const base = new Map(baselines.map(b => [b.uuid, b.totals]));
    // Başlangıcı olmayan (dönem içinde ilk kez görülen) oyuncunun başlangıcı sıfırdır: o ana kadarki her şey bu döneme sayılır
    return current.map(c => ({ uuid: c._id, username: c.username, totals: sub(c.totals, base.get(c._id)) }));
}

/** Biten haftayı kapatır: tabloyu saklar, birincilere rozet ve pelerin verir. */
async function closeWeek(week) {
    const already = await col('leaderboard_weeks').findOne({ _id: week });
    if (already) return already;
    const User = require('../models/User');
    const capes = require('./capes');
    const categories = rank(await periodRows('week:' + week), 10);
    const doc = { _id: week, categories, closedAt: new Date() };
    try { await col('leaderboard_weeks').insertOne(doc); } catch { return col('leaderboard_weeks').findOne({ _id: week }); }
    for (const c of categories) {
        const winner = c.rows[0];
        if (!winner) continue;
        const def = settings.WEEKLY_STATS[c.key];
        if (!def || !cfg().weekly.enabled) continue;
        await giveBadge(winner.username, def.badge);
        if (cfg().weekly.cape) await capes.grant(User, winner.username, cfg().weekly.cape, `${week} haftası: ${c.name}`);
    }
    return doc;
}

/** Sezon görevleri ve pelerini (kazanılanlar bir kez verilir). */
async function awardSeason(season) {
    const User = require('../models/User');
    const capes = require('./capes');
    for (const row of await periodRows('season:' + season.key)) {
        let done = 0;
        for (const q of season.quests) {
            const r = questRaw(q);
            if ((row.totals[r.stat] || 0) >= r.target) { done++; await giveBadgeOnce(row.username, `${season.key}-${q.key}`); }
        }
        if (!season.cape) continue;
        const allQuests = season.quests.length > 0 && done === season.quests.length;
        const byLevel = season.capeLevel > 0 && levelOf(xpOf(row.totals)).level >= season.capeLevel;
        if (allQuests || byLevel) await capes.grant(User, row.username, season.cape, season.name);
    }
}

let running = false;
/** Bir tur: istatistikleri oku, kaydet, gerekirse haftayı kapat, sezon ödüllerini ver. */
async function tick(now = new Date(), stats = null) {
    if (running) return;
    running = true;
    try {
        await settings.load();
        const server = stats || readServerStats();
        if (server.size === 0) return;
        const accounts = await accountsByUuid();
        const players = [...server].filter(([uuid]) => accounts.has(uuid)).map(([uuid, totals]) => ({ uuid, username: accounts.get(uuid), totals }));
        const known = new Set((await col('player_stats').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id));
        if (players.length) await col('player_stats').bulkWrite(players.map(p => ({
            updateOne: { filter: { _id: p.uuid }, update: { $set: { username: p.username, totals: p.totals, updatedAt: now } }, upsert: true },
        })), { ordered: false });

        const week = weekKey(now);
        const state = (await col('progress_state').findOne({ _id: 'state' })) || {};
        if (state.week && state.week !== week) await closeWeek(state.week);
        await ensureBaselines('week:' + week, players, known);
        if (state.week !== week) await col('progress_state').updateOne({ _id: 'state' }, { $set: { week } }, { upsert: true });

        const season = currentSeason(now);
        if (season) {
            await ensureBaselines('season:' + season.key, players, known);
            await awardSeason(season);
        }
    } finally { running = false; }
}

let timer = null;
function start() {
    if (!INSTANCE || timer) return;
    const run = () => tick().catch(err => console.error('İlerleme güncellenemedi:', err.message));
    setTimeout(run, 20 * 1000).unref();
    timer = setInterval(run, TICK_MS);
    timer.unref();
}

// ── Okuma (route'lar) ─────────────────────────────────────────────────────
async function leaderboard(period = 'week', now = new Date()) {
    await settings.load();
    const week = weekKey(now);
    let rows;
    if (period === 'all') rows = (await col('player_stats').find({}).toArray()).map(r => ({ username: r.username, totals: r.totals }));
    else if (period === 'season') { const s = currentSeason(now); rows = s ? await periodRows('season:' + s.key) : []; }
    else rows = await periodRows('week:' + week);
    const start = weekStart(now);
    const last = await col('leaderboard_weeks').find({}).sort({ _id: -1 }).limit(1).next();
    return {
        period,
        weekStart: start.toISOString(),
        weekEnd: new Date(start.getTime() + 7 * 86400000).toISOString(),
        season: (s => s && { key: s.key, name: s.name, endsAt: s.endsAt })(currentSeason(now)),
        categories: rank(rows, period === 'all' ? 25 : 10),
        lastWeek: last ? { week: last._id, winners: last.categories.map(c => ({ key: c.key, name: c.name, icon: c.icon, winner: c.rows[0] || null })) } : null,
        updatedAt: (await col('player_stats').find({}).sort({ updatedAt: -1 }).limit(1).next())?.updatedAt || null,
    };
}

/** Bir oyuncunun seviyesi, sezonu ve görevleri. */
async function progressOf(username, now = new Date()) {
    await settings.load();
    const { offlineUuid } = require('./yggdrasil');
    const uuid = offlineUuid(username);
    const doc = await col('player_stats').findOne({ _id: uuid });
    const totals = doc ? doc.totals : ZERO;
    const level = levelOf(xpOf(totals));
    const season = currentSeason(now);
    let seasonInfo = null;
    if (season) {
        const base = await col('stat_baselines').findOne({ _id: `season:${season.key}:${uuid}` });
        const gained = sub(totals, base ? base.totals : ZERO);
        const sl = levelOf(xpOf(gained));
        seasonInfo = {
            key: season.key, name: season.name, startsAt: season.startsAt, endsAt: season.endsAt, cape: season.cape, capeLevel: season.capeLevel,
            level: sl.level, xp: sl.xp, from: sl.from, to: sl.to, progress: sl.progress,
            quests: season.quests.map(q => {
                const r = questRaw(q);
                const value = Math.min(q.target, (gained[r.stat] || 0) / r.scale);
                const done = (gained[r.stat] || 0) >= r.target;
                const shown = r.scale > 1 ? Math.floor(value * 10) / 10 : Math.floor(value);
                return {
                    key: q.key, name: q.name, desc: q.desc, icon: q.icon, target: q.target, value, done,
                    text: done ? 'Tamamlandı ✓' : `${shown.toLocaleString('tr-TR')} / ${q.target.toLocaleString('tr-TR')} ${r.unit}`,
                };
            }),
        };
    }
    return {
        level: level.level, xp: level.xp, from: level.from, to: level.to, progress: level.progress,
        played: !!doc,
        totals: { playtime: display('time', totals.playTicks), diamonds: totals.diamonds, deaths: totals.deaths, distance: display('distance', totals.distanceCm), mobKills: totals.mobKills, advancements: totals.advancements },
        season: seasonInfo,
    };
}

/** Profil için kısa özet (seviye). */
async function levelsOf(usernames) {
    const { offlineUuid } = require('./yggdrasil');
    const ids = usernames.map(u => offlineUuid(u));
    const docs = await col('player_stats').find({ _id: { $in: ids } }).toArray();
    const map = new Map(docs.map(d => [d.username, levelOf(xpOf(d.totals)).level]));
    return Object.fromEntries(usernames.map(u => [u, map.get(u) || 0]));
}

module.exports = {
    extract, countAdvancements, xpOf, levelOf, xpForLevel, weekStart, weekKey, rank, display, sub,
    badgeInfo, badgeDef, currentSeason, categories, questRaw, settings,
    readServerStats, tick, start, leaderboard, progressOf, levelsOf, closeWeek,
};
