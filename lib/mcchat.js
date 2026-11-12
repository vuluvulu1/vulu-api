// Oyun içi sohbet köprüsü: VDS'teki Minecraft sunucusunun sohbeti launcher'ın Sunucular sekmesinde görünür, launcher'dan
// yazılan mesajlar oyuna düşer.
//   Okuma: sunucunun logs/latest.log dosyası saniyede bir okunur; sohbet, giriş ve çıkış satırları ayıklanıp son 200'ü
//          bellekte tutulur. (Dosya döndürülünce baştan okunur.)
//   Yazma: RCON ile `tellraw @a` — "[Launcher] ad: mesaj". RCON şifresi sunucunun server.properties dosyasından okunur.
//
// Ayarlar (.env):
//   MC_CHAT_INSTANCE  sunucunun klasörü (ör. /srv/vulu-panel/instances/vulu-resmi); yoksa özellik kapalıdır
//   MC_CHAT_ADDRESS   bu klasörün hangi sunucu kartına ait olduğu (varsayılan vuluvulu.com.tr)
const fs = require('fs');
const net = require('net');
const path = require('path');

const INSTANCE = process.env.MC_CHAT_INSTANCE || '';
const ADDRESS = (process.env.MC_CHAT_ADDRESS || 'vuluvulu.com.tr').toLowerCase();
const MAX = 200;

const messages = [];
let seq = 0;
let offset = -1;      // -1: henüz okunmadı (açılışta son 64 KB okunur)
let partial = '';
let timer = null;

const enabled = () => !!INSTANCE;

/** Bu sunucu kartının sohbeti var mı (adres eşleşiyorsa; port 25565 yazılmış da olsa). */
function servesAddress(address) {
    if (!enabled() || typeof address !== 'string') return false;
    const a = address.toLowerCase().replace(/:25565$/, '');
    return a === ADDRESS;
}

function push(entry) {
    messages.push({ seq: ++seq, at: new Date().toISOString(), ...entry });
    if (messages.length > MAX) messages.splice(0, messages.length - MAX);
}

// [19:29:01] [Server thread/INFO]: <ad> mesaj   (Forge/NeoForge: [Server thread/INFO] [minecraft/MinecraftServer]: ...)
const PREFIX = /^\[\d\d:\d\d:\d\d\] \[Server thread\/INFO\](?: \[[^\]]*\])?: (.*)$/;
const CHAT = /^(?:\[Not Secure\] )?<([A-Za-z0-9_]{1,16})> (.*)$/;
const JOIN = /^([A-Za-z0-9_]{1,16}) joined the game$/;
const LEAVE = /^([A-Za-z0-9_]{1,16}) left the game$/;
const SAY = /^\[(?:Server|Rcon)\] (.*)$/;

function parse(line) {
    const m = PREFIX.exec(line);
    if (!m) return;
    const body = m[1].replace(/§./g, '');
    let x;
    if ((x = CHAT.exec(body))) push({ kind: 'chat', name: x[1], text: x[2].slice(0, 256) });
    else if ((x = JOIN.exec(body))) push({ kind: 'join', name: x[1], text: '' });
    else if ((x = LEAVE.exec(body))) push({ kind: 'leave', name: x[1], text: '' });
    else if ((x = SAY.exec(body))) push({ kind: 'server', name: '', text: x[1].slice(0, 256) });
}

function readNew() {
    const file = path.join(INSTANCE, 'logs', 'latest.log');
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    if (offset < 0) offset = Math.max(0, stat.size - 64 * 1024);
    if (stat.size < offset) { offset = 0; partial = ''; }   // dosya döndürüldü (sunucu yeniden başladı)
    if (stat.size === offset) return;
    const length = Math.min(stat.size - offset, 1024 * 1024);
    const buf = Buffer.alloc(length);
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, length, offset);
    } catch { return; } finally { if (fd !== undefined) fs.closeSync(fd); }
    offset += length;
    const text = partial + buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) parse(line);
}

function start() {
    if (!enabled() || timer) return;
    try { readNew(); } catch (err) { console.error('Oyun sohbeti okunamadı:', err.message); }
    timer = setInterval(() => { try { readNew(); } catch (err) { console.error('Oyun sohbeti okunamadı:', err.message); } }, 1000);
    timer.unref();
}

/** after: son görülen seq. Açılışta (after yok) son 50 mesaj. */
function since(after) {
    start();
    const n = Number(after);
    const list = Number.isFinite(n) && n > 0 ? messages.filter(m => m.seq > n) : messages.slice(-50);
    return { messages: list, seq };
}

// ── RCON ──────────────────────────────────────────────────────────────────
function rconSettings() {
    const props = fs.readFileSync(path.join(INSTANCE, 'server.properties'), 'utf8');
    const get = key => (new RegExp('^' + key.replace('.', '\\.') + '=(.*)$', 'm').exec(props) || [])[1]?.trim();
    if (get('enable-rcon') !== 'true') throw new Error('Sunucuda RCON kapalı.');
    return { port: Number(get('rcon.port')) || 25575, password: get('rcon.password') || '' };
}

function packet(id, type, body) {
    const payload = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(14 + payload.length);
    buf.writeInt32LE(10 + payload.length, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    payload.copy(buf, 12);
    return buf;   // son iki bayt zaten 0
}

/** Tek komut: bağlan, kimlik doğrula, komutu gönder, kapat. */
function rcon(command) {
    const { port, password } = rconSettings();
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        let data = Buffer.alloc(0), authed = false;
        const done = (err, value) => { socket.destroy(); err ? reject(err) : resolve(value); };
        socket.setTimeout(5000, () => done(new Error('Oyun sunucusu cevap vermedi.')));
        socket.on('error', () => done(new Error('Oyun sunucusuna bağlanılamadı (kapalı olabilir).')));
        socket.on('connect', () => socket.write(packet(1, 3, password)));
        socket.on('data', chunk => {
            data = Buffer.concat([data, chunk]);
            while (data.length >= 4) {
                const len = data.readInt32LE(0);
                if (data.length < 4 + len) return;
                const id = data.readInt32LE(4);
                const body = data.toString('utf8', 12, 4 + len - 2);
                data = data.subarray(4 + len);
                if (!authed) {
                    if (id === -1) return done(new Error('RCON şifresi yanlış.'));
                    authed = true;
                    socket.write(packet(2, 2, command));
                } else return done(null, body);
            }
        });
    });
}

/** Launcher'dan gelen mesaj oyunda herkese: [Launcher] ad: mesaj. */
async function send(username, text) {
    const clean = String(text).replace(/§./g, '').replace(/[\u0000-\u001f\u007f§]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) throw new Error('Boş mesaj gönderilemez.');
    const components = ['',
        { text: '[Launcher] ', color: 'gold' },
        { text: username, color: 'yellow' },
        { text: ': ', color: 'gray' },
        { text: clean, color: 'white' }];
    await rcon('tellraw @a ' + JSON.stringify(components));
    push({ kind: 'launcher', name: username, text: clean });
    return messages[messages.length - 1];
}

module.exports = { enabled, servesAddress, since, send, start };
