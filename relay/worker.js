// vulu yedek yolu (Cloudflare Worker). Kullanıcının ağı vuluvulu.com.tr'ye ulaşamadığında (engel, kesinti) launcher
// istekleri bu Worker'ın adresine gönderir; Worker onları Cloudflare'in kendi ağı üzerinden vulu sunucusuna iletir.
// Kullanıcının ağı yalnızca workers.dev adresini ve Cloudflare IP'lerini görür.
//
// Kurulum: Cloudflare → Workers & Pages → Create → Worker → bu kodu yapıştır → Deploy.
// Settings → Variables and Secrets → Add → Type: Secret, Name: RELAY_KEY, Value: uzun rastgele bir metin.
// Aynı değer VDS'te /srv/vulu-api/shared/.env dosyasına RELAY_KEY=... olarak yazılır (systemctl restart vulu-api).
// RELAY_KEY ile sunucu, isteğin gerçekten bu Worker'dan geldiğini anlar ve kullanıcının gerçek IP'sini kullanır
// (giriş denemesi sınırları kişi başına işlesin, herkes Cloudflare'in tek IP'sine sayılmasın).

const ORIGIN = 'https://vuluvulu.com.tr';
// Yalnızca launcher'ın kullandığı yollar iletilir
const ALLOWED = ['/api/', '/releases/'];

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/' || url.pathname === '/health')
            return new Response('vulu relay', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
        if (!ALLOWED.some(prefix => url.pathname.startsWith(prefix)))
            return new Response('Not found', { status: 404 });

        const headers = new Headers(request.headers);
        // İstemcinin kendi gönderdiği vulu başlıkları atılır; yalnızca Worker ekler
        for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith('x-vulu-')) headers.delete(name);
        headers.delete('host');
        if (env.RELAY_KEY) {
            headers.set('x-vulu-relay-key', env.RELAY_KEY);
            headers.set('x-vulu-client-ip', request.headers.get('cf-connecting-ip') || '');
        }

        const target = ORIGIN + url.pathname + url.search;
        const init = { method: request.method, headers, redirect: 'manual' };
        if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
        return fetch(target, init);
    },
};
