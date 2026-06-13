const express = require('express');
const router = express.Router();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO;
const MANIFEST_PATH = process.env.GITHUB_MANIFEST_PATH;
const GITHUB_API    = 'https://api.github.com';

// GitHub'dan manifest'i çek
async function getManifest() {
    const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${MANIFEST_PATH}`, {
        headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json'
        }
    });

    if (res.status === 404) return { content: { instances: {} }, sha: null };
    if (!res.ok) throw new Error(`GitHub API hatası: ${res.status}`);

    const data = await res.json();
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { content, sha: data.sha };
}

// GitHub'a manifest'i push'la
async function pushManifest(content, sha) {
    const body = {
        message: `chore: manifest güncellendi`,
        content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
        ...(sha && { sha })
    };

    const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${MANIFEST_PATH}`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(`GitHub push hatası: ${err.message}`);
    }

    return await res.json();
}

// GET /manifest — manifest'i çek (herkese açık)
router.get('/', async (req, res) => {
    try {
        const { content } = await getManifest();
        res.json(content);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /manifest/push — manifest güncelle (sadece admin token ile)
router.post('/push', async (req, res) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token gerekli.' });

    const jwt = require('jsonwebtoken');
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.isAdmin) return res.status(403).json({ error: 'Yetkisiz.' });
    } catch {
        return res.status(401).json({ error: 'Geçersiz token.' });
    }

    const { instance, files } = req.body;
    // instance: "AGLR"
    // files: [{ path: "config/ftbquests/...", hash: "abc123", url: "https://raw...", size: 1234 }]

    if (!instance || !files) 
        return res.status(400).json({ error: 'instance ve files gerekli.' });

    try {
        const { content, sha } = await getManifest();

        content.instances[instance] = {
            updatedAt: new Date().toISOString(),
            files
        };

        await pushManifest(content, sha);
        res.json({ success: true, fileCount: files.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;