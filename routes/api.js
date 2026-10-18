// JSON endpoints used by the browse UI.
import express from 'express';
import prisma from '../lib/prisma.js';
import { isAuth, requireProfileApi } from '../middleware/auth.js';
import { browseContext, cardsFor } from './browse.js';
import { titleCard, continueWatching, similarTitles, searchTitles, isFinished, splitGenres, youtubeId, allGenres } from '../lib/library.js';

const router = express.Router();
router.use(isAuth, requireProfileApi);

const DAY = 86_400_000;
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && Math.abs(n) <= 2147483647 ? n : null; };
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error('[api]', e); res.status(500).json({ error: 'Something went wrong' }); });

router.get('/titles/:id', wrap(async (req, res) => {
    const id = int(req.params.id);
    const ctx = await browseContext(req);
    const m = ctx.lib.byId.get(id);
    if (!m || !ctx.lib.visibleIds.has(id)) return res.status(404).json({ error: 'Not found' });
    const card = titleCard(m, ctx.lib, ctx.state, ctx.aff, ctx.downloading);
    const eps = ctx.lib.epBySeries.get(m.id) || [];

    const seasons = [];
    for (const e of eps) {
        const s = e.season || 1;
        let bucket = seasons.find(x => x.season === s);
        if (!bucket) { bucket = { season: s, episodes: [] }; seasons.push(bucket); }
        const p = ctx.state.progressBy.get(e.id);
        bucket.episodes.push({
            id: e.id, order: e.order, title: e.title, description: e.description || '', duration: e.duration,
            thumbnail: e.thumbnail || m.thumbnail || m.backdrop || '',
            pct: p && p.duration > 0 ? Math.min(1, p.position / p.duration) : 0,
            downloading: ctx.downloading.has(e.id) ? Math.round(ctx.downloading.get(e.id) * 100) : null,
            playable: !!e.path
        });
    }

    let play = null;
    if (m.type === 'series') {
        const cw = continueWatching(ctx.lib, ctx.state).find(x => x.title.id === m.id);
        const target = cw ? ctx.lib.epById.get(cw.playId) : eps.find(e => e.path);
        if (target) play = { id: target.id, resume: !!cw && cw.pct > 0.01, season: target.season || 1, order: target.order, title: target.title, pct: cw ? cw.pct : 0 };
    } else if (m.path) {
        const p = ctx.state.progressBy.get(m.id);
        const resumable = p && !isFinished(p, m) && p.position > 30;
        play = { id: m.id, resume: !!resumable, pct: resumable && p.duration ? p.position / p.duration : 0, remaining: resumable ? Math.round((p.duration - p.position) / 60) : null };
    }

    const similar = similarTitles(m, ctx.lib, 12).map(s => titleCard(s, ctx.lib, ctx.state, ctx.aff, ctx.downloading));
    res.json({
        title: {
            ...card,
            description: m.description || '',
            tagline: m.tagline || '',
            allGenres: splitGenres(m.genres),
            category: m.category,
            cast: splitGenres(m.cast),
            director: m.director || '',
            trailer: youtubeId(m.trailerUrl)
        },
        play, seasons, similar,
        canManage: !!res.locals.canAdmin
    });
}));

router.post('/mylist/:id', wrap(async (req, res) => {
    const mediaId = int(req.params.id);
    if (!mediaId) return res.status(400).json({ error: 'bad id' });
    const userId = req.profile.id;
    const existing = await prisma.myListItem.findUnique({ where: { userId_mediaId: { userId, mediaId } } });
    if (existing) {
        await prisma.myListItem.delete({ where: { id: existing.id } });
        return res.json({ inList: false });
    }
    await prisma.myListItem.create({ data: { userId, mediaId } });
    res.json({ inList: true });
}));

router.post('/rate/:id', wrap(async (req, res) => {
    const mediaId = int(req.params.id);
    const value = int(req.body.value);
    if (!mediaId || ![-1, 0, 1, 2].includes(value)) return res.status(400).json({ error: 'bad input' });
    const key = { userId_mediaId: { userId: req.profile.id, mediaId } };
    if (value === 0) await prisma.rating.deleteMany({ where: { userId: req.profile.id, mediaId } });
    else await prisma.rating.upsert({ where: key, update: { value }, create: { userId: req.profile.id, mediaId, value } });
    res.json({ value });
}));

router.post('/progress', wrap(async (req, res) => {
    const mediaId = int(req.body.mediaId);
    const position = parseFloat(req.body.position);
    const duration = parseFloat(req.body.duration);
    if (!mediaId || !Number.isFinite(position) || position < 0) return res.status(400).json({ error: 'bad input' });
    const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const userId = req.profile.id;
    await prisma.watchProgress.upsert({
        where: { userId_mediaId: { userId, mediaId } },
        update: { position, duration: dur },
        create: { userId, mediaId, position, duration: dur }
    });
    res.json({ ok: true });
}));

// "Remove from row" in Continue Watching
router.delete('/progress/:id', wrap(async (req, res) => {
    const id = int(req.params.id);
    const m = await prisma.media.findUnique({ where: { id }, select: { id: true, type: true } });
    if (!m) return res.status(404).json({ error: 'Not found' });
    const ids = [m.id];
    if (m.type === 'series') {
        const eps = await prisma.media.findMany({ where: { parentId: m.id }, select: { id: true } });
        ids.push(...eps.map(e => e.id));
    }
    await prisma.watchProgress.deleteMany({ where: { userId: req.profile.id, mediaId: { in: ids } } });
    res.json({ ok: true });
}));

router.get('/search', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const ctx = await browseContext(req);
    const results = q ? searchTitles(ctx.lib, q, 60) : [];
    const ids = results.map(m => m.id);
    const related = q ? allGenres(results).slice(0, 8).map(g => g.name) : [];
    res.json({ q, ids, titles: cardsFor(ids, ctx), related });
}));

router.get('/notifications', wrap(async (req, res) => {
    const ctx = await browseContext(req);
    const since = Date.now() - 21 * DAY;
    const items = [];
    for (const m of ctx.lib.titles) {
        if (new Date(m.created_at).getTime() >= since) items.push({ id: m.id, kind: 'new', title: m.title, img: m.thumbnail || m.backdrop || m.poster || '', at: m.created_at });
    }
    for (const [sid, eps] of ctx.lib.epBySeries) {
        if (!ctx.lib.visibleIds.has(sid)) continue;
        const fresh = eps.filter(e => new Date(e.created_at).getTime() >= since);
        const s = ctx.lib.byId.get(sid);
        if (fresh.length && s && new Date(s.created_at).getTime() < since) {
            items.push({ id: sid, kind: 'episodes', count: fresh.length, title: s.title, img: s.thumbnail || s.backdrop || '', at: fresh[fresh.length - 1].created_at });
        }
    }
    items.sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ items: items.slice(0, 12) });
}));

export default router;
