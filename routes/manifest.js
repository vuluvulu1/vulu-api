const express = require('express');
const axios   = require('axios');
const router  = express.Router();
const jwt     = require('jsonwebtoken');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;
const MANIFEST_PATH = process.env.GITHUB_MANIFEST_PATH;
const GITHUB_API    = 'https://api.github.com';

const githubHeaders = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept':        'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
};

async function getManifest() {
    try {
        const res = await axios.get(
            `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${MANIFEST_PATH}`,
            { headers: githubHeaders }
        );
        const content = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
        return { content, sha: res.data.sha };
    } catch (err) {
        if (err.response?.status === 404)
            return { content: { instances: {} }, sha: null };
        throw new Error(`GitHub getManifest hatası: ${err.message}`);
    }
}

async function pushManifest(content, sha) {
    const body = {
        message: 'chore: manifest güncellendi',
        content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
        ...(sha && { sha })
    };

    const res = await axios.put(
        `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${MANIFEST_PATH}`,
        body,
        { headers: { ...githubHeaders, 'Content-Type': 'application/json' } }
    );

    return res.data;
}

// GET /manifest
router.get('/', async (req, res) => {
    try {
        const { content } = await getManifest();
        res.json(content);
    } catch (err) {
        console.error('GET /manifest hata:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /manifest/push
router.post('/push', async (req, res) => {
    // ... auth kontrolü aynı ...

    const { instance, files, deletedFiles, modsVersion, modsUrl } = req.body;
    if (!instance || !files)
        return res.status(400).json({ error: 'instance ve files gerekli.' });

    try {
        const { content, sha } = await getManifest();
        content.instances = content.instances || {};
        content.instances[instance] = {
            updatedAt:    new Date().toISOString(),
            files,
            deletedFiles: deletedFiles || [],
            modsVersion:  modsVersion  || content.instances[instance]?.modsVersion || null,
            modsUrl:      modsUrl      || content.instances[instance]?.modsUrl      || null
        };

        await pushManifest(content, sha);
        res.json({ success: true, fileCount: files.length });
    } catch (err) {
        console.error('POST /manifest/push hata:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /manifest/delete — silinecek dosya ekle/kaldır
router.post('/delete', async (req, res) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token gerekli.' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.isAdmin) return res.status(403).json({ error: 'Yetkisiz.' });
    } catch {
        return res.status(401).json({ error: 'Geçersiz token.' });
    }

    const { instance, deletedFiles } = req.body;
    if (!instance || !deletedFiles)
        return res.status(400).json({ error: 'instance ve deletedFiles gerekli.' });

    try {
        const { content, sha } = await getManifest();
        content.instances = content.instances || {};

        if (!content.instances[instance])
            return res.status(404).json({ error: 'Instance bulunamadı.' });

        content.instances[instance].deletedFiles = deletedFiles;

        await pushManifest(content, sha);
        res.json({ success: true });
    } catch (err) {
        console.error('POST /manifest/delete hata:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;