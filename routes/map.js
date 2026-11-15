const express = require('express');
const fs = require('fs');
const path = require('path');
const Friendship = require('../models/Friendship');
const mcchat = require('../lib/mcchat');
const { requireAuth } = require('../middleware/auth');

// Canlı dünya haritası (vulu-resmi). Karoları API çizmez: ayrı, düşük öncelikli bir iş (lib/worldmap/render.js,
// deploy/worldmap.timer) MAP_DIR'e yazar; API yalnızca dosyaları verir. Oyuncu konumları RCON'dan, yalnızca kendin
// ve arkadaşların için.
const router = express.Router();
const MAP_DIR = process.env.MAP_DIR || '/srv/vulu-api/shared/map';
const DIMS = new Set(['overworld', 'the_nether', 'the_end']);

const enabled = () => fs.existsSync(path.join(MAP_DIR, 'overworld', 'index.json'));

// GET /map/info — hangi boyutlar ve bölgeler çizildi
router.get('/info', requireAuth, (req, res) => {
    const dims = {};
    for (const dim of DIMS) {
        try { dims[dim] = JSON.parse(fs.readFileSync(path.join(MAP_DIR, dim, 'index.json'), 'utf8')); } catch { /* çizilmemiş */ }
    }
    res.json({ enabled: Object.keys(dims).length > 0, dims });
});

// GET /map/tile/:dim/:zoom/:x/:z — 512 px PNG; zoom 0 = 1 blok/piksel, her seviye 2 kat uzak
router.get('/tile/:dim/:zoom/:x/:z', requireAuth, (req, res) => {
    const { dim } = req.params, zoom = Number(req.params.zoom), x = Number(req.params.x), z = Number(req.params.z);
    if (!DIMS.has(dim) || !Number.isInteger(zoom) || zoom < 0 || zoom > 3 || !Number.isInteger(x) || !Number.isInteger(z)
        || Math.abs(x) > 100000 || Math.abs(z) > 100000) return res.status(404).end();
    const file = path.join(MAP_DIR, dim, String(zoom), `r.${x}.${z}.png`);
    fs.stat(file, (err, stat) => {
        if (err) return res.status(404).end();
        const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
        res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=60', ETag: etag });
        if (req.headers['if-none-match'] === etag) return res.status(304).end();
        fs.createReadStream(file).pipe(res);
    });
});

// ── Oyuncu konumları ──────────────────────────────────────────────────────
let positions = { at: 0, players: [] };
let pending = null;

const POS = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/;
const DIM = /"(?:minecraft:)?([a-z_]+)"/;

/** Çevrimiçi oyuncular ve konumları; RCON en çok 5 saniyede bir sorulur. */
async function readPositions() {
    if (Date.now() - positions.at < 5000) return positions.players;
    if (pending) return pending;
    pending = (async () => {
        try {
            const list = await mcchat.rcon('list');
            const names = (list.split(':')[1] || '').split(',').map(s => s.trim()).filter(n => /^[A-Za-z0-9_]{1,16}$/.test(n)).slice(0, 50);
            const players = [];
            for (const name of names) {
                const pos = POS.exec(await mcchat.rcon(`data get entity ${name} Pos`));
                const dim = DIM.exec(await mcchat.rcon(`data get entity ${name} Dimension`));
                if (pos) players.push({ name, x: Math.round(+pos[1]), y: Math.round(+pos[2]), z: Math.round(+pos[3]), dim: dim ? dim[1] : 'overworld' });
            }
            positions = { at: Date.now(), players };
        } catch { positions = { at: Date.now(), players: [] }; }
        finally { pending = null; }
        return positions.players;
    })();
    return pending;
}

// GET /map/players — kendin ve çevrimiçi arkadaşların (başkalarının yeri gösterilmez)
router.get('/players', requireAuth, async (req, res) => {
    if (!mcchat.enabled()) return res.json({ players: [], online: 0 });
    const all = await readPositions();
    const friends = new Set(await Friendship.friendsOf(req.user.username));
    friends.add(req.user.username);
    res.json({
        online: all.length,
        players: all.filter(p => friends.has(p.name)).map(p => ({ ...p, you: p.name === req.user.username })),
    });
});

module.exports = router;
module.exports.enabled = enabled;
