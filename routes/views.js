import express from 'express';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const isAuth = (req, res, next) => req.isAuthenticated() ? next() : res.redirect('/login');
const isAuthApi = (req, res, next) => req.isAuthenticated() ? next() : res.status(401).json({ error: 'auth' });

async function buildHomeData(userId, { typeFilter } = {}) {
    const whereType = typeFilter ? { type: typeFilter } : { type: { in: ['movie', 'series'] } };
    const media = await prisma.media.findMany({ where: whereType, orderBy: { id: 'desc' } });

    const progressItems = await prisma.watchProgress.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        include: { media: true },
        take: 20
    });
    const continueWatching = progressItems
        .map(p => {
            const m = p.media;
            if (!m) return null;
            if (m.type === 'episode' && m.parentId) {
                return { ...m, _progress: p, _resumeId: m.id };
            }
            return { ...m, _progress: p, _resumeId: m.id };
        })
        .filter(Boolean);

    const myList = await prisma.myListItem.findMany({
        where: { userId },
        include: { media: true },
        orderBy: { addedAt: 'desc' }
    });
    const myListIds = new Set(myList.map(m => m.mediaId));
    const myListItems = myList.map(m => m.media).filter(Boolean);

    const trending = media.filter(m => m.trending).slice(0, 10);

    const rows = {};
    media.forEach(m => {
        const cat = m.category || 'General';
        if (!rows[cat]) rows[cat] = [];
        rows[cat].push(m);
    });

    const heroPool = media.filter(m => m.backdrop || m.thumbnail);
    const hero = heroPool.length > 0
        ? heroPool[Math.floor(Math.random() * Math.min(heroPool.length, 5))]
        : (media[0] || null);

    return { media, rows, hero, continueWatching, myListItems, myListIds, trending };
}

router.get('/', isAuth, async (req, res) => {
    const data = await buildHomeData(req.user.id);
    res.render('index', { ...data, pageType: 'home' });
});

router.get('/series', isAuth, async (req, res) => {
    const data = await buildHomeData(req.user.id, { typeFilter: 'series' });
    res.render('index', { ...data, pageType: 'series' });
});

router.get('/movies', isAuth, async (req, res) => {
    const data = await buildHomeData(req.user.id, { typeFilter: 'movie' });
    res.render('index', { ...data, pageType: 'movies' });
});

router.get('/mylist', isAuth, async (req, res) => {
    const myList = await prisma.myListItem.findMany({
        where: { userId: req.user.id },
        include: { media: true },
        orderBy: { addedAt: 'desc' }
    });
    const items = myList.map(m => m.media).filter(Boolean);
    res.render('mylist', { items, myListIds: new Set(items.map(i => i.id)) });
});

router.get('/search', isAuth, async (req, res) => {
    const q = (req.query.q || '').trim();
    let results = [];
    if (q.length > 0) {
        results = await prisma.media.findMany({
            where: {
                AND: [
                    { type: { in: ['movie', 'series'] } },
                    {
                        OR: [
                            { title: { contains: q } },
                            { description: { contains: q } },
                            { category: { contains: q } },
                            { genres: { contains: q } }
                        ]
                    }
                ]
            },
            take: 60
        });
    }
    const myList = await prisma.myListItem.findMany({ where: { userId: req.user.id }, select: { mediaId: true } });
    const myListIds = new Set(myList.map(m => m.mediaId));
    res.render('search', { q, results, myListIds });
});

router.get('/watch/:id', isAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.redirect('/');
    const media = await prisma.media.findUnique({ where: { id } });
    if (!media) return res.redirect('/');

    if (media.type === 'series') {
        const episodes = await prisma.media.findMany({ where: { parentId: media.id }, orderBy: { order: 'asc' } });
        const myListEntry = await prisma.myListItem.findUnique({
            where: { userId_mediaId: { userId: req.user.id, mediaId: media.id } }
        }).catch(() => null);
        const episodeIds = episodes.map(e => e.id);
        const epProgress = episodeIds.length
            ? await prisma.watchProgress.findMany({
                where: { userId: req.user.id, mediaId: { in: episodeIds } }
            })
            : [];
        const progressMap = {};
        epProgress.forEach(p => { progressMap[p.mediaId] = p; });
        return res.render('series', { series: media, episodes, inMyList: !!myListEntry, progressMap });
    }

    // movie or episode → player
    const progress = await prisma.watchProgress.findUnique({
        where: { userId_mediaId: { userId: req.user.id, mediaId: media.id } }
    }).catch(() => null);

    let nextEpisode = null;
    let parent = null;
    if (media.type === 'episode' && media.parentId) {
        parent = await prisma.media.findUnique({ where: { id: media.parentId } });
        const siblings = await prisma.media.findMany({
            where: { parentId: media.parentId },
            orderBy: { order: 'asc' }
        });
        const idx = siblings.findIndex(s => s.id === media.id);
        if (idx !== -1 && idx + 1 < siblings.length) nextEpisode = siblings[idx + 1];
    }

    res.render('watch', { media, progress, nextEpisode, parent });
});

// --- API: progress save ---
router.post('/api/progress', isAuthApi, async (req, res) => {
    try {
        const { mediaId, position, duration } = req.body;
        const mid = parseInt(mediaId);
        const pos = parseFloat(position);
        const dur = parseFloat(duration);
        if (!Number.isFinite(mid) || !Number.isFinite(pos)) return res.status(400).json({ error: 'bad input' });
        await prisma.watchProgress.upsert({
            where: { userId_mediaId: { userId: req.user.id, mediaId: mid } },
            update: { position: pos, duration: Number.isFinite(dur) ? dur : 0 },
            create: { userId: req.user.id, mediaId: mid, position: pos, duration: Number.isFinite(dur) ? dur : 0 }
        });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'fail' });
    }
});

// --- API: my list toggle ---
router.post('/api/mylist/:id', isAuthApi, async (req, res) => {
    const mid = parseInt(req.params.id);
    if (!Number.isFinite(mid)) return res.status(400).json({ error: 'bad' });
    const existing = await prisma.myListItem.findUnique({
        where: { userId_mediaId: { userId: req.user.id, mediaId: mid } }
    }).catch(() => null);
    if (existing) {
        await prisma.myListItem.delete({ where: { id: existing.id } });
        return res.json({ inList: false });
    }
    await prisma.myListItem.create({ data: { userId: req.user.id, mediaId: mid } });
    res.json({ inList: true });
});

// --- API: details modal ---
router.get('/api/details/:id', isAuthApi, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad' });
    const m = await prisma.media.findUnique({ where: { id } });
    if (!m) return res.status(404).json({ error: 'not found' });
    let episodes = [];
    if (m.type === 'series') {
        episodes = await prisma.media.findMany({ where: { parentId: m.id }, orderBy: { order: 'asc' } });
    }
    const myListEntry = await prisma.myListItem.findUnique({
        where: { userId_mediaId: { userId: req.user.id, mediaId: m.id } }
    }).catch(() => null);
    const progress = await prisma.watchProgress.findUnique({
        where: { userId_mediaId: { userId: req.user.id, mediaId: m.id } }
    }).catch(() => null);
    res.json({ media: m, episodes, inMyList: !!myListEntry, progress });
});

// --- Video streaming with HTTP Range support ---
router.get('/stream/:id', isAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).end();
    const media = await prisma.media.findUnique({ where: { id } });
    if (!media || !media.path) return res.status(404).end();

    // If path is an external URL, redirect
    if (/^https?:\/\//i.test(media.path)) {
        return res.redirect(media.path);
    }

    const filePath = path.join(PUBLIC_DIR, media.path.replace(/^\//, ''));
    if (!fs.existsSync(filePath)) return res.status(404).end();

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.mov': 'video/quicktime',
        '.m4v': 'video/x-m4v',
        '.avi': 'video/x-msvideo'
    }[ext] || 'video/mp4';

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 1024 * 1024 - 1, fileSize - 1);
        if (isNaN(start) || start >= fileSize) {
            res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
            return;
        }
        const chunkSize = end - start + 1;
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mime,
            'Cache-Control': 'no-store'
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': mime,
            'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(filePath).pipe(res);
    }
});

export default router;
