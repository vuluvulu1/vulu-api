const express = require('express');
const mongoose = require('mongoose');

/**
 * İndirme sayacı: sitedeki ve README'deki indirme bağlantıları buraya gelir, sayaç artar ve asıl dosyaya
 * yönlendirilir. Yalnızca kurulum indirmeleri sayılır; launcher'ın kendi güncellemeleri doğrudan /releases'ten
 * iner ve sayılmaz. Aynı adresten bir saat içindeki tekrarlar ve bağlantı önizlemesi yapan botlar sayılmaz.
 */
const router = express.Router();

const FILES = {
    windows: '/releases/vulu-launcher-setup.exe',
    android: '/releases/android/vulu-launcher.apk',
};
const REPEAT_MS = 60 * 60 * 1000;
const BOT = /bot|crawl|spider|slurp|preview|discord|whatsapp|telegram|facebookexternalhit|embed|curl|wget|python|headless/i;

const recent = new Map();   // "ip|tür" → son sayılma zamanı
setInterval(() => {
    const now = Date.now();
    for (const [key, at] of recent) if (now - at > REPEAT_MS) recent.delete(key);
}, 10 * 60 * 1000).unref();

const counts = () => mongoose.connection.db.collection('downloads');

// Sayaçtan önceki kurulum indirmeleri: GitHub sürümlerindeki vulu-launcher-setup.exe sayısı (0.9.x–0.14.x).
// Sunucudan inen kurulumlar o dönem kayıt altına alınmadı.
const BEFORE_COUNTER = { windows: 4, android: 0 };

/** İndirme sayıları: { windows, android, total }. */
async function downloadCounts() {
    const docs = await counts().find({ _id: { $in: Object.keys(FILES) } }).toArray();
    const result = Object.fromEntries(Object.keys(FILES).map(k => [k, (docs.find(d => d._id === k)?.count || 0) + (BEFORE_COUNTER[k] || 0)]));
    result.total = Object.values(result).reduce((a, b) => a + b, 0);
    return result;
}

// GET /download/windows, /download/android
router.get('/:kind', async (req, res) => {
    const file = FILES[req.params.kind];
    if (!file) return res.status(404).json({ error: 'Böyle bir indirme yok.' });

    const key = `${req.ip}|${req.params.kind}`;
    const agent = req.get('user-agent') || '';
    // HEAD yalnızca dosyayı yoklar, indirmez
    if (req.method === 'GET' && !BOT.test(agent) && agent.length > 0 && !(recent.has(key) && Date.now() - recent.get(key) < REPEAT_MS)) {
        recent.set(key, Date.now());
        try { await counts().updateOne({ _id: req.params.kind }, { $inc: { count: 1 } }, { upsert: true }); }
        catch (err) { console.error('İndirme sayılamadı:', err.message); }   // indirme sayaç yüzünden engellenmez
    }
    res.set('Cache-Control', 'no-store');
    res.redirect(302, file);
});

router.downloadCounts = downloadCounts;
module.exports = router;
