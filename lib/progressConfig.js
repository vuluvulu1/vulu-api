// İlerleme ayarları: sezonlar, görevler (başarımlar), seviye/XP katsayıları ve haftalık liderlik dalları.
// Admin panelinden düzenlenir; veritabanında tek belge olarak durur (progress_config / _id: 'config').
// Belge yoksa ya da bir alanı eksikse aşağıdaki varsayılanlar kullanılır.
'use strict';
const mongoose = require('mongoose');

/** Görevlerin sayabileceği istatistikler: arayüzdeki birimiyle (saat, km) ve oyunun ham birimine çarpanı. */
const STATS = {
    playHours: { label: 'Oynama süresi (saat)', raw: 'playTicks', scale: 72000, unit: 'saat' },
    diamonds: { label: 'Kazılan elmas cevheri', raw: 'diamonds', scale: 1, unit: 'elmas' },
    distanceKm: { label: 'Gidilen yol (km)', raw: 'distanceCm', scale: 100000, unit: 'km' },
    mobKills: { label: 'Yenilen yaratık', raw: 'mobKills', scale: 1, unit: 'yaratık' },
    advancements: { label: 'Kazanılan başarım', raw: 'advancements', scale: 1, unit: 'başarım' },
    deaths: { label: 'Ölüm', raw: 'deaths', scale: 1, unit: 'ölüm' },
};

/** Haftalık dallar: anahtar ve istatistik sabit, ad, rozet adı, simge ve açık/kapalı düzenlenir. */
const WEEKLY_STATS = {
    playtime: { stat: 'playTicks', unit: 'time', badge: 'hafta-oyuncu' },
    diamonds: { stat: 'diamonds', unit: 'count', badge: 'hafta-elmas' },
    deaths: { stat: 'deaths', unit: 'count', badge: 'hafta-olum' },
    distance: { stat: 'distanceCm', unit: 'distance', badge: 'hafta-gezgin' },
};

const DEFAULT = {
    levelBase: 50,   // L. seviye için toplam levelBase·L·(L+1) XP
    xp: { minute: 1, diamond: 15, advancement: 25, km: 4, mobs10: 1 },
    weekly: {
        enabled: true,
        cape: 'haftalik-sampiyon',
        categories: [
            { key: 'playtime', name: 'En çok oynayan', badgeName: 'Haftanın oyuncusu', icon: '⏱', enabled: true },
            { key: 'diamonds', name: 'En çok elmas bulan', badgeName: 'Haftanın elmas avcısı', icon: '💎', enabled: true },
            { key: 'deaths', name: 'En çok ölen', badgeName: 'Haftanın talihsizi', icon: '💀', enabled: true },
            { key: 'distance', name: 'En uzağa giden', badgeName: 'Haftanın gezgini', icon: '🧭', enabled: true },
        ],
    },
    seasons: [
        {
            key: 's1', name: 'Sezon 1', startsAt: '2026-11-16T00:00:00+03:00', endsAt: '2027-02-15T00:00:00+03:00',
            cape: 'sezon-1', capeLevel: 10,
            quests: [
                { key: 'yola-cikis', name: 'Yola çıkış', desc: 'Sunucuda 2 saat oyna.', stat: 'playHours', target: 2, icon: '⏱' },
                { key: 'elmas-avcisi', name: 'Elmas avcısı', desc: '16 elmas cevheri kaz.', stat: 'diamonds', target: 16, icon: '💎' },
                { key: 'gezgin', name: 'Gezgin', desc: '25 km yol git.', stat: 'distanceKm', target: 25, icon: '🧭' },
                { key: 'avci', name: 'Avcı', desc: '150 yaratık yen.', stat: 'mobKills', target: 150, icon: '⚔' },
                { key: 'kasif', name: 'Kâşif', desc: '20 başarım kazan.', stat: 'advancements', target: 20, icon: '🏅' },
            ],
        },
    ],
    // Silinen ya da adı değişen görevlerin rozetleri profillerde adıyla görünmeye devam etsin diye: rozet anahtarı → tanım
    badgeArchive: {},
};

const KEY = /^[a-z0-9-]{1,32}$/;
const bad = message => Object.assign(new Error(message), { status: 400 });
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null; };

/**
 * Gelen ayarı denetler ve temizler. Hatalıysa status 400'lü bir hata fırlatır (admin paneli mesajı gösterir).
 * capeExists: pelerin anahtarı katalogda mı.
 */
function normalize(input, capeExists = () => true) {
    const c = input && typeof input === 'object' ? input : {};
    const out = {};
    out.levelBase = num(c.levelBase ?? DEFAULT.levelBase, 5, 10000);
    if (out.levelBase === null) throw bad('Seviye katsayısı bir sayı olmalı.');
    const xp = c.xp || {};
    out.xp = {};
    for (const k of Object.keys(DEFAULT.xp)) {
        const v = num(xp[k] ?? DEFAULT.xp[k], 0, 100000);
        if (v === null) throw bad('XP katsayıları sayı olmalı.');
        out.xp[k] = v;
    }

    const w = c.weekly || DEFAULT.weekly;
    const weeklyCape = text(w.cape ?? DEFAULT.weekly.cape, 32);
    if (weeklyCape && !capeExists(weeklyCape)) throw bad(`Haftalık pelerin bulunamadı: ${weeklyCape}`);
    out.weekly = {
        enabled: w.enabled !== false,
        cape: weeklyCape,
        categories: Object.keys(WEEKLY_STATS).map(key => {
            const given = (w.categories || []).find(x => x && x.key === key) || DEFAULT.weekly.categories.find(x => x.key === key);
            return {
                key,
                name: text(given.name, 40) || key,
                badgeName: text(given.badgeName, 40) || key,
                icon: text(given.icon, 4) || '★',
                enabled: given.enabled !== false,
            };
        }),
    };

    const seasons = Array.isArray(c.seasons) ? c.seasons : DEFAULT.seasons;
    if (seasons.length > 50) throw bad('En çok 50 sezon olabilir.');
    const seenSeason = new Set();
    out.seasons = seasons.map((s, i) => {
        const key = text(s.key, 32).toLowerCase();
        const name = text(s.name, 40);
        if (!KEY.test(key)) throw bad(`Sezon ${i + 1}: anahtar küçük harf, rakam ve tire olmalı (ör. s2).`);
        if (seenSeason.has(key)) throw bad(`Aynı sezon anahtarı iki kez: ${key}`);
        seenSeason.add(key);
        if (!name) throw bad(`${key}: sezonun adı boş olamaz.`);
        const startsAt = new Date(s.startsAt), endsAt = new Date(s.endsAt);
        if (isNaN(startsAt) || isNaN(endsAt)) throw bad(`${name}: başlangıç ve bitiş tarihi geçerli olmalı.`);
        if (endsAt <= startsAt) throw bad(`${name}: bitiş başlangıçtan sonra olmalı.`);
        const cape = text(s.cape, 32);
        if (cape && !capeExists(cape)) throw bad(`${name}: pelerin bulunamadı (${cape}).`);
        const capeLevel = num(s.capeLevel ?? 0, 0, 1000);
        const quests = Array.isArray(s.quests) ? s.quests : [];
        if (quests.length > 30) throw bad(`${name}: en çok 30 görev olabilir.`);
        const seenQuest = new Set();
        return {
            key, name, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), cape, capeLevel: capeLevel || 0,
            quests: quests.map((q, j) => {
                const qkey = text(q.key, 32).toLowerCase();
                if (!KEY.test(qkey)) throw bad(`${name}, görev ${j + 1}: anahtar küçük harf, rakam ve tire olmalı.`);
                if (seenQuest.has(qkey)) throw bad(`${name}: aynı görev anahtarı iki kez (${qkey}).`);
                seenQuest.add(qkey);
                if (!STATS[q.stat]) throw bad(`${name}, ${qkey}: bilinmeyen istatistik.`);
                const target = num(q.target, 0, 1e9);
                if (!target) throw bad(`${name}, ${qkey}: hedef sıfırdan büyük olmalı.`);
                const qname = text(q.name, 40);
                if (!qname) throw bad(`${name}, ${qkey}: görevin adı boş olamaz.`);
                return { key: qkey, name: qname, desc: text(q.desc, 120), icon: text(q.icon, 4) || '★', stat: q.stat, target };
            }),
        };
    });
    // Tarihleri çakışan sezon olmasın: aynı anda tek sezon sürer
    const sorted = [...out.seasons].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (let i = 1; i < sorted.length; i++)
        if (sorted[i].startsAt < sorted[i - 1].endsAt) throw bad(`${sorted[i - 1].name} ile ${sorted[i].name} tarihleri çakışıyor.`);

    out.badgeArchive = { ...(c.badgeArchive || {}) };
    return out;
}

/** Ayardaki her görevin rozet tanımı arşive eklenir (sonra silinse de adı kalsın). */
function archiveBadges(config) {
    for (const s of config.seasons)
        for (const q of s.quests)
            config.badgeArchive[`${s.key}-${q.key}`] = { name: q.name, desc: `${s.name}: ${q.desc}`, icon: q.icon, season: s.key };
    return config;
}

let current = archiveBadges(normalize(DEFAULT));
let loadedAt = 0;

/** Önbellekteki ayar (en çok 30 sn eski). */
function get() { return current; }

/** Veritabanından okur (30 sn önbellek; force ile hemen). Bağlantı yoksa son bilinen ayar kalır. */
async function load(force = false) {
    if (!force && Date.now() - loadedAt < 30 * 1000) return current;
    try {
        const doc = await mongoose.connection.db.collection('progress_config').findOne({ _id: 'config' });
        current = archiveBadges(normalize(doc ? doc.config : DEFAULT));
        loadedAt = Date.now();
    } catch (err) { console.error('İlerleme ayarı okunamadı:', err.message); }
    return current;
}

async function save(input, by) {
    const capes = require('./capes');
    const config = archiveBadges(normalize({ ...input, badgeArchive: { ...current.badgeArchive, ...(input && input.badgeArchive) } }, capes.exists));
    await mongoose.connection.db.collection('progress_config').updateOne({ _id: 'config' },
        { $set: { config, updatedAt: new Date(), updatedBy: by || '' } }, { upsert: true });
    current = config;
    loadedAt = Date.now();
    return config;
}

/** Test için: ayarı doğrudan ver. */
function set(config) { current = archiveBadges(normalize(config)); loadedAt = Date.now(); }

module.exports = { STATS, WEEKLY_STATS, DEFAULT, normalize, get, load, save, set };
