// Torrent downloads: page, REST API and a live Server-Sent Events feed.
import express from 'express';
import fs from 'fs';
import engine, { defaultSelection, guessKind } from '../lib/torrents.js';
import { DOWNLOAD_DIR } from '../lib/config.js';
import { isAdmin } from '../middleware/auth.js';
import { torrentUpload } from '../middleware/upload.js';
import { parseRelease } from '../lib/release-name.js';
import * as tmdb from '../lib/tmdb.js';

const router = express.Router();
const int = (v) => parseInt(v, 10);
const wrap = (fn) => (req, res) => fn(req, res).catch(e => res.status(400).json({ error: e.message || String(e) }));

export function diskInfo() {
    try {
        const s = fs.statfsSync(DOWNLOAD_DIR);
        return { total: s.blocks * s.bsize, free: s.bavail * s.bsize, path: DOWNLOAD_DIR };
    } catch { return { total: 0, free: 0, path: DOWNLOAD_DIR }; }
}

router.get('/downloads', isAdmin, (req, res, next) => {
    // A magnet link opened from another site only pre-fills the dialog: nothing is added without a click.
    const magnet = typeof req.query.magnet === 'string' ? req.query.magnet.trim().split(/\s/)[0].slice(0, 4000) : '';
    tmdb.tmdbEnabled().then(tmdbOn => res.render('downloads', {
        enabled: engine.enabled,
        reason: engine.disabledReason,
        tmdbOn,
        disk: diskInfo(),
        initialMagnet: /^magnet:\?/i.test(magnet) ? magnet : ''
    })).catch(next);
});

const payload = (disk) => ({ torrents: engine.snapshot(), summary: engine.summary(), finished: engine.recent, disk });

router.get('/api/torrents', isAdmin, (req, res) => res.json(payload(diskInfo())));

router.get('/api/torrents/summary', isAdmin, (req, res) => res.json(engine.summary()));

router.get('/api/torrents/events', isAdmin, (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    let diskAt = 0, disk = diskInfo();
    const send = () => {
        if (Date.now() - diskAt > 10000) { disk = diskInfo(); diskAt = Date.now(); }
        res.write(`data: ${JSON.stringify(payload(disk))}\n\n`);
    };
    let queued = false;
    const onChange = () => {
        if (queued) return;
        queued = true;
        setTimeout(() => { queued = false; send(); }, 120);
    };
    send();
    engine.on('stats', send);
    engine.on('change', onChange);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
        engine.off('stats', send);
        engine.off('change', onChange);
        clearInterval(ping);
    });
});

router.get('/api/torrents/:id', isAdmin, (req, res) => {
    const d = engine.describe(int(req.params.id));
    if (!d) return res.status(404).json({ error: 'Not found' });
    res.json(d);
});

router.post('/api/torrents', isAdmin, torrentUpload.single('torrent'), wrap(async (req, res) => {
    const magnet = String(req.body.magnet || '').trim();
    const url = String(req.body.url || '').trim();
    let source = {};
    if (req.file) source = { buffer: req.file.buffer };
    else if (/^https?:\/\//i.test(magnet)) source = { url: magnet };
    else if (magnet) source = { magnet };
    else if (url) source = { url };
    const { row, duplicate } = await engine.add({
        ...source,
        addedById: req.user.id,
        start: req.body.start === '1' || req.body.start === 'true' ? {} : null
    });
    res.json({ id: row.id, duplicate });
}));

router.post('/api/torrents/:id/start', isAdmin, wrap(async (req, res) => {
    const id = int(req.params.id);
    const { files, kind, autoImport, match } = req.body || {};
    await engine.start(id, { files, kind, autoImport: autoImport !== false, match: match === undefined ? undefined : (match || null) });
    res.json(engine.describe(id));
}));

router.post('/api/torrents/:id/pause', isAdmin, wrap(async (req, res) => {
    await engine.pause(int(req.params.id));
    res.json({ ok: true });
}));

router.post('/api/torrents/:id/resume', isAdmin, wrap(async (req, res) => {
    await engine.resume(int(req.params.id));
    res.json({ ok: true });
}));

router.delete('/api/torrents/:id', isAdmin, wrap(async (req, res) => {
    await engine.remove(int(req.params.id), { deleteFiles: req.query.files === '1' });
    res.json({ ok: true });
}));

// Change the TMDB match / type after starting; re-imports into the library.
router.post('/api/torrents/:id/match', isAdmin, wrap(async (req, res) => {
    const id = int(req.params.id);
    const { match, kind } = req.body || {};
    const row = engine.rows.get(id);
    if (!row) throw new Error('Torrent not found');
    if (row.status === 'pending' || row.status === 'metadata') {
        await engine._update(id, { match: match ? JSON.stringify(match) : null, ...(kind ? { kind } : {}) });
    } else {
        await engine.reimport(id, { match: match || null, kind });
    }
    res.json(engine.describe(id));
}));

// What the torrent looks like: parsed name + TMDB suggestions.
router.get('/api/torrents/:id/suggest', isAdmin, wrap(async (req, res) => {
    const d = engine.describe(int(req.params.id));
    if (!d) return res.status(404).json({ error: 'Not found' });
    const parsed = parseRelease(d.name);
    const files = d.files || [];
    const kind = ['movie', 'series', 'other'].includes(req.query.kind) ? req.query.kind
        : (d.kind !== 'auto' ? d.kind : guessKind(d.name, files));
    let results = [], tmdbError = null;
    const q = String(req.query.q || parsed.title || '').trim();
    if (await tmdb.tmdbEnabled() && q) {
        try {
            results = await tmdb.search(q, { type: kind === 'other' ? undefined : kind, year: req.query.q ? undefined : parsed.year });
            if (!results.length && !req.query.q && parsed.year) results = await tmdb.search(q, { type: kind === 'other' ? undefined : kind });
            if (!req.query.q) {
                const best = await tmdb.autoMatch(parsed, kind).catch(() => null);
                if (best) results = [best, ...results.filter(r => !(r.tmdbId === best.tmdbId && r.type === best.type))];
            }
        } catch (e) { tmdbError = e.message; }
    }
    res.json({
        parsed, kind, query: q, tmdbOn: await tmdb.tmdbEnabled(), tmdbError,
        results: results.slice(0, 8),
        defaultFiles: files.length ? defaultSelection(files) : []
    });
}));

export default router;
