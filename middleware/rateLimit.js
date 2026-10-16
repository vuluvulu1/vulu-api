/**
 * Bellekte tutulan basit sayaç: bir anahtar (IP, kullanıcı adı) belirli bir sürede en fazla `max` kez geçebilir.
 * Tek sunucu (Render) için yeterli; sunucu yeniden başlarsa sayaçlar sıfırlanır.
 */
function createCounter({ windowMs, max }) {
    const hits = new Map(); // anahtar → { count, resetAt }

    // Süresi dolanlar ara ara temizlenir; zamanlayıcı süreci açık tutmaz
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
    }, Math.min(windowMs, 60_000)).unref();

    const current = key => {
        const now = Date.now();
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        return entry;
    };

    return {
        /** Sınır aşıldıysa true. Saymaz. */
        blocked: key => current(key).count >= max,
        /** Bir kez sayar; sınır aşıldıysa true döner. */
        hit: key => ++current(key).count > max,
        reset: key => hits.delete(key),
    };
}

/** Express ara katmanı: IP başına istek sınırı. */
function limitByIp({ windowMs, max, message }) {
    const counter = createCounter({ windowMs, max });
    return (req, res, next) => {
        if (counter.hit(req.ip || 'unknown')) return res.status(429).json({ error: message });
        next();
    };
}

module.exports = { createCounter, limitByIp };
