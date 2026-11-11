const crypto = require('crypto');
const net = require('net');

/**
 * Yedek yol (relay/worker.js): ağı vuluvulu.com.tr'ye ulaşamayan kullanıcıların istekleri Cloudflare Worker üzerinden
 * gelir. Worker, RELAY_KEY'i ve kullanıcının gerçek IP'sini ekler; anahtar tutarsa req.ip o IP olur (IP başına
 * sınırlar herkesi tek Cloudflare IP'sine saymasın). Anahtarsız ya da yanlış anahtarlı başlıklar yok sayılır.
 */
function relayClientIp(req, res, next) {
    const expected = process.env.RELAY_KEY || '';
    const key = req.get('x-vulu-relay-key');
    if (key && expected && key.length === expected.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
        const ip = String(req.get('x-vulu-client-ip') || '').trim();
        if (net.isIP(ip)) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    }
    next();
}

module.exports = { relayClientIp };
