// Oyunda seviye görünümü: vulu-resmi'de çevrimiçi oyuncuların adının önüne "[Sv 12]" gibi bir önek konur. Minecraft'ın
// kendi takım önekleri kullanılır (RCON: team add/modify/join); mod gerekmez. Önek tab listesinde, sohbette ve
// kafanın üstündeki isimde görünür. Her seviye için bir takım (vulu_lv<N>) açılır; seviyesi 0 olan önek almaz.
//
// Ne zaman: oyuncu sunucuya girince (sohbet köprüsü "joined the game" satırını görür) ve istatistikler her
// yenilendiğinde (5 dakikada bir). Yalnızca değişen oyuncular için komut gönderilir.
// Ayar: Admin › İlerleme › Oyunda seviye (lib/progressConfig.js: levelTag). Kapatılınca vulu takımları silinir.
'use strict';
const mcchat = require('./mcchat');
const settings = require('./progressConfig');

const PREFIX = 'vulu_lv';
const COLORS = ['gold', 'yellow', 'aqua', 'green', 'light_purple', 'red', 'white', 'gray', 'dark_aqua', 'dark_purple'];

const applied = new Map();   // oyuncu → uygulanan "seviye|biçim|renk"
const teams = new Set();     // bu çalışmada açılmış/ayarlanmış takımlar ("ad|biçim|renk")
let running = null;

const prefixText = (format, level) => String(format || '[Sv {level}] ').replace(/\{level\}/g, String(level)).slice(0, 32);
const component = (text, color) => JSON.stringify({ text, color: COLORS.includes(color) ? color : 'gold' });

/** Çevrimiçi oyuncu adları (RCON list). */
async function onlinePlayers() {
    const list = await mcchat.rcon('list');
    return (list.split(':')[1] || '').split(',').map(s => s.trim()).filter(n => /^[A-Za-z0-9_]{1,16}$/.test(n));
}

/** Bütün vulu takımlarını siler (özellik kapatılınca). */
async function clearAll() {
    const out = await mcchat.rcon('team list');
    const names = [...out.matchAll(/\[(vulu_lv\d+)\]/g)].map(m => m[1]);
    for (const name of names) await mcchat.rcon(`team remove ${name}`);
    applied.clear();
    teams.clear();
}

/**
 * Çevrimiçi oyuncuların (ya da yalnızca verilen oyuncunun) önekini günceller. Sunucu kapalıysa sessizce geçer.
 * levelsOf: kullanıcı adları → seviye (lib/progress.js levelsOf).
 */
async function sync(levelsOf, only = null) {
    if (!mcchat.enabled()) return;
    if (running) return running;
    running = (async () => {
        const cfg = (await settings.load()).levelTag;
        if (!cfg.enabled) {
            if (applied.size > 0 || teams.size > 0) await clearAll();
            return;
        }
        const names = only ? [only] : await onlinePlayers();
        if (names.length === 0) return;
        const levels = await levelsOf(names);
        for (const name of names) {
            const level = levels[name] || 0;
            const key = `${level}|${cfg.format}|${cfg.color}`;
            if (applied.get(name) === key) continue;
            if (level <= 0) {
                if (applied.has(name)) await mcchat.rcon(`team leave ${name}`);
                applied.set(name, key);
                continue;
            }
            const team = `${PREFIX}${level}`;
            const teamKey = `${team}|${cfg.format}|${cfg.color}`;
            if (!teams.has(teamKey)) {
                await mcchat.rcon(`team add ${team}`);   // zaten varsa hata metni döner; önemli değil
                await mcchat.rcon(`team modify ${team} prefix ${component(prefixText(cfg.format, level), cfg.color)}`);
                teams.add(teamKey);
            }
            await mcchat.rcon(`team join ${team} ${name}`);
            applied.set(name, key);
        }
        // Çıkan oyuncular unutulur; yeniden girince önekleri tekrar uygulanır
        if (!only) for (const name of [...applied.keys()]) if (!names.includes(name)) applied.delete(name);
    })().catch(err => console.error('Oyun içi seviye öneki güncellenemedi:', err.message)).finally(() => { running = null; });
    return running;
}

/** Ayar değişince (admin kaydetti) bir sonraki turda her şey baştan uygulansın. */
function reset() { applied.clear(); teams.clear(); }

module.exports = { sync, reset, prefixText, component, COLORS };
