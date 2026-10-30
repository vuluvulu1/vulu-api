const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

/**
 * vulu Packs aynası: paketlerdeki mod, kaynak paketi ve shader dosyalarının bir kopyası sunucu diskinde durur;
 * launcher önce buradan indirir, olmazsa dosyanın asıl kaynağına (Modrinth, CurseForge) döner. Böylece
 * oyuncunun bağlantısı CDN'lerden birine takılınca paket yarım kalmaz.
 *
 * Dosyalar SHA-1'lerine göre saklanır (PACKFILES_DIR/ab/abcdef…): aynı dosya paketler ve revizyonlar arasında
 * bir kez yer kaplar. Sunucu dosyaları paketteki adreslerden kendisi indirir ve hash'iyle doğrular; hiçbir
 * paketin kullanmadığı dosyalar her aynalamadan sonra silinir. PACKFILES_DIR ayarlı değilse ayna kapalıdır.
 */

const SHA1 = /^[0-9a-f]{40}$/;
const PARALLEL = 3;
const dir = () => process.env.PACKFILES_DIR || null;

/** SHA-1'in diskteki yolu; geçersiz hash ya da ayna kapalıysa null. */
function blobPath(sha1) {
    const root = dir();
    const hash = String(sha1 || '').toLowerCase();
    if (!root || !SHA1.test(hash)) return null;
    return path.join(root, hash.slice(0, 2), hash);
}

/** Dosya aynada var mı (paket listesinde launcher'a bildirilir; olmayanlar için boşuna istek atılmasın). */
function has(sha1) {
    const file = blobPath(sha1);
    return !!file && fs.existsSync(file);
}

/** Dosyayı adresinden indirir; hash ve boyut tutarsa yerine taşır. */
async function fetchInto(mod, file, allowedHosts) {
    const response = await fetch(mod.url, { headers: { 'User-Agent': 'vulu-api (+https://vuluvulu.com.tr)' }, signal: AbortSignal.timeout(10 * 60 * 1000) });
    // Yönlendirme sonrası da yalnızca izin verilen dağıtım sunucuları
    if (!allowedHosts.some(h => response.url.startsWith(h))) throw new Error(`izin verilmeyen adrese yönlendirdi: ${response.url}`);
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const part = `${file}.${process.pid}.part`;
    const sha1 = crypto.createHash('sha1');
    const sha512 = crypto.createHash('sha512');
    let size = 0;
    try {
        const body = Readable.fromWeb(response.body);
        body.on('data', chunk => { sha1.update(chunk); sha512.update(chunk); size += chunk.length; });
        await pipeline(body, fs.createWriteStream(part));
        if (sha1.digest('hex') !== mod.sha1.toLowerCase()) throw new Error('SHA-1 uyuşmuyor');
        if (mod.sha512 && sha512.digest('hex') !== String(mod.sha512).toLowerCase()) throw new Error('SHA-512 uyuşmuyor');
        if (mod.size && Number(mod.size) !== size) throw new Error('boyut uyuşmuyor');
        fs.renameSync(part, file);
    } finally {
        fs.rmSync(part, { force: true });
    }
    return size;
}

/** Hiçbir paketin kullanmadığı dosyaları siler. */
function prune(referenced) {
    const root = dir();
    if (!root || !fs.existsSync(root)) return 0;
    let removed = 0;
    for (const prefix of fs.readdirSync(root)) {
        const sub = path.join(root, prefix);
        if (!fs.statSync(sub).isDirectory()) continue;
        for (const name of fs.readdirSync(sub)) {
            // Yarım kalmış indirmeler de temizlenir
            if (SHA1.test(name) && referenced.has(name)) continue;
            fs.rmSync(path.join(sub, name), { force: true });
            removed++;
        }
    }
    return removed;
}

let running = null;
let again = false;

/**
 * Bütün paketleri aynalar ve artık kullanılmayan dosyaları siler. Aynı anda tek çalışma olur; çalışırken yeni
 * istek gelirse (ör. arka arkaya iki yayın) bittiğinde bir kez daha çalışır. Hatalar yalnızca loglanır.
 */
function sync(loadPacks, allowedHosts) {
    if (!dir()) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
        do {
            again = false;
            try { await syncOnce(loadPacks, allowedHosts); }
            catch (err) { console.error('Paket aynası:', err.message); }
        } while (again);
        running = null;
    })();
    return running;
}

async function syncOnce(loadPacks, allowedHosts) {
    const packs = await loadPacks();
    const wanted = new Map();
    for (const pack of packs)
        for (const mod of pack.mods || [])
            if (mod && SHA1.test(String(mod.sha1 || '').toLowerCase()) && typeof mod.url === 'string' && allowedHosts.some(h => mod.url.startsWith(h)))
                wanted.set(mod.sha1.toLowerCase(), mod);

    const missing = [...wanted.entries()].filter(([sha1]) => !has(sha1));
    let added = 0, bytes = 0, failed = 0;
    let next = 0;
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
        while (next < missing.length) {
            const [sha1, mod] = missing[next++];
            // await önce biter, sonra toplanır (aynı satırda "bytes += await" paralel işçilerde birbirini ezer)
            try { const size = await fetchInto(mod, blobPath(sha1), allowedHosts); bytes += size; added++; }
            catch (err) { failed++; console.error(`Paket aynası: ${mod.title || mod.file || sha1} indirilemedi: ${err.message}`); }
        }
    }));

    const removed = prune(new Set(wanted.keys()));
    if (added || failed || removed)
        console.log(`Paket aynası: ${added} dosya eklendi (${Math.round(bytes / 1048576)} MB), ${failed} başarısız, ${removed} silindi; toplam ${wanted.size}.`);
}

module.exports = { blobPath, has, sync };
