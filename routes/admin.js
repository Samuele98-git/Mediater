// Admin: library management, title editor, users, settings and system status.
import express from 'express';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma.js';
import engine from '../lib/torrents.js';
import { upload, uploadPath } from '../middleware/upload.js';
import { isAdmin } from '../middleware/auth.js';
import { saveSettings, getSettings } from '../lib/settings.js';
import { tools, transcodeStats } from '../lib/ffmpeg.js';
import { jobStatus } from '../lib/jobs.js';
import { resolveMediaPath, fileExists } from '../lib/media-paths.js';
import { applyTmdb, fillEpisodesFromTmdb, queueAnalysis, clearDerived, splitGenres } from '../lib/library.js';
import { guessSubtitleInfo, languageName } from '../lib/subtitles.js';
import * as tmdb from '../lib/tmdb.js';
import { DOWNLOAD_DIR, UPLOAD_DIR, CACHE_DIR, DATA_DIR } from '../lib/config.js';
import { diskInfo } from './downloads.js';

const router = express.Router();
router.use(isAdmin);

const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const float = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const str = (v) => (v == null ? '' : String(v).trim());
const page = (fn) => (req, res, next) => fn(req, res).catch(next);

/** "1:30" / "01:02:03" / "90" -> seconds */
function parseTime(v) {
    const s = str(v);
    if (!s) return null;
    const parts = s.split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n))) return null;
    return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0));
}

const ART_FIELDS = [
    { field: 'poster', url: 'posterUrl', col: 'poster' },
    { field: 'thumbnail', url: 'thumbnailUrl', col: 'thumbnail' },
    { field: 'backdrop', url: 'backdropUrl', col: 'backdrop' },
    { field: 'logo', url: 'logoUrlInput', col: 'logoUrl' }
];
const uploadFields = upload.fields([
    { name: 'poster', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }, { name: 'backdrop', maxCount: 1 },
    { name: 'logo', maxCount: 1 }, { name: 'video', maxCount: 1 }, { name: 'trailerFile', maxCount: 1 }
]);

function mediaData(req, existing) {
    const b = req.body || {};
    const f = req.files || {};
    const type = existing ? existing.type : (['movie', 'series'].includes(b.type) ? b.type : 'movie');
    const data = {
        title: str(b.title) || (existing && existing.title) || 'Untitled',
        description: str(b.description),
        tagline: str(b.tagline) || null,
        releaseYear: int(b.releaseYear),
        duration: int(b.duration),
        maturity: str(b.maturity) || null,
        cast: str(b.cast) || null,
        director: str(b.director) || null,
        rating: float(b.rating),
        introStart: parseTime(b.introStart),
        introEnd: parseTime(b.introEnd),
        creditsStart: parseTime(b.creditsStart)
    };
    if (type !== 'episode') {
        Object.assign(data, {
            category: str(b.category) || splitGenres(b.genres)[0] || 'General',
            genres: splitGenres(b.genres).join(', '),
            trending: b.trending === 'on',
            tmdbId: int(b.tmdbId), imdbId: str(b.imdbId) || null
        });
    } else {
        data.season = int(b.season) || 1;
        data.order = int(b.order) || 1;
    }
    for (const a of ART_FIELDS) {
        if (f[a.field] && f[a.field][0]) data[a.col] = uploadPath(f[a.field][0]);
        else if (b[a.url] !== undefined) data[a.col] = str(b[a.url]) || null;
    }
    if (f.trailerFile && f.trailerFile[0]) data.trailerUrl = uploadPath(f.trailerFile[0]);
    else if (b.trailerUrl !== undefined) data.trailerUrl = str(b.trailerUrl) || null;

    if (f.video && f.video[0]) data.path = uploadPath(f.video[0]);
    else if (b.videoPath !== undefined) {
        const p = str(b.videoPath);
        data.path = p || null;
    }
    return data;
}

function videoChanged(before, data) {
    return data.path !== undefined && (before ? before.path : null) !== data.path;
}

// ------------------------------------------------------------ dashboard
router.get('/', page(async (req, res) => {
    const [titles, users, episodeCounts, subCount] = await Promise.all([
        prisma.media.findMany({ where: { type: { in: ['movie', 'series'] } }, orderBy: { id: 'desc' } }),
        prisma.user.findMany({ where: { parentId: null }, orderBy: { id: 'asc' }, include: { _count: { select: { profiles: true } } } }),
        prisma.media.groupBy({ by: ['parentId'], where: { type: 'episode' }, _count: { _all: true } }),
        prisma.subtitle.count()
    ]);
    const epCount = new Map(episodeCounts.map(e => [e.parentId, e._count._all]));
    const t = tools();
    res.render('admin', {
        titles: titles.map(m => ({
            id: m.id, title: m.title, type: m.type, year: m.releaseYear, img: m.poster || m.thumbnail || m.backdrop || '',
            landscape: !m.poster, episodes: epCount.get(m.id) || 0, category: m.category, trending: m.trending,
            playable: m.type === 'series' ? (epCount.get(m.id) || 0) > 0 : !!m.path,
            downloading: m.torrentId != null
        })),
        users,
        tab: ['library', 'users', 'settings', 'system'].includes(req.query.tab) ? req.query.tab : 'library',
        flash: req.query.flash || null,
        system: {
            ffmpeg: t.ffmpeg, ffprobe: t.ffprobe, transcodes: transcodeStats().active,
            torrents: engine.summary(), jobs: jobStatus(), disk: diskInfo(), subCount,
            dirs: { data: DATA_DIR, downloads: DOWNLOAD_DIR, uploads: UPLOAD_DIR, cache: CACHE_DIR },
            tmdbOn: await tmdb.tmdbEnabled(), node: process.version
        }
    });
}));

// ------------------------------------------------------------ titles
async function renderEditor(res, media, extra = {}) {
    const isSeries = media && media.type === 'series';
    const episodes = isSeries ? await prisma.media.findMany({ where: { parentId: media.id }, orderBy: [{ season: 'asc' }, { order: 'asc' }] }) : [];
    const subtitles = media && media.id && media.type !== 'series' ? await prisma.subtitle.findMany({ where: { mediaId: media.id }, orderBy: { id: 'asc' } }) : [];
    const parent = media && media.type === 'episode' ? await prisma.media.findUnique({ where: { id: media.parentId } }) : null;
    const videoOk = media && media.path ? fileExists(media.path) || /^https?:/i.test(media.path) : false;
    let probe = null;
    try { probe = media && media.probe ? JSON.parse(media.probe) : null; } catch { /* ignore */ }
    res.render('admin-title', {
        media, episodes, subtitles, parent, videoOk, probe,
        tmdbOn: await tmdb.tmdbEnabled(),
        torrent: media && media.torrentId ? engine.describe(media.torrentId, { withFiles: false }) : null,
        langs: ['en', 'it', 'es', 'fr', 'de', 'pt', 'tr', 'nl', 'ru', 'ja', 'ko', 'zh', 'ar', 'pl', 'sv'].map(c => ({ code: c, name: languageName(c, res.locals.lang) })),
        ...extra
    });
}

router.get('/title/new', page(async (req, res) => {
    const type = req.query.type === 'series' ? 'series' : 'movie';
    let draft = { id: null, type, title: '', genres: '', category: '' };
    if (req.query.tmdb && await tmdb.tmdbEnabled()) {
        try {
            const d = await tmdb.details(type, int(req.query.tmdb));
            draft = { ...draft, ...d, type, id: null, category: splitGenres(d.genres)[0] || '' };
        } catch (e) { draft.error = e.message; }
    }
    await renderEditor(res, draft, { isNew: true });
}));

router.post('/title/new', uploadFields, page(async (req, res) => {
    const data = mediaData(req, null);
    data.type = ['movie', 'series'].includes(req.body.type) ? req.body.type : 'movie';
    const m = await prisma.media.create({ data });
    if (m.path) queueAnalysis(m.id);
    res.redirect(`/admin/title/${m.id}?saved=1`);
}));

router.get('/title/:id(\\d+)', page(async (req, res) => {
    const m = await prisma.media.findUnique({ where: { id: int(req.params.id) } });
    if (!m) return res.redirect('/admin');
    await renderEditor(res, m, { saved: req.query.saved === '1', error: req.query.error || null });
}));

router.post('/title/:id(\\d+)', uploadFields, page(async (req, res) => {
    const id = int(req.params.id);
    const before = await prisma.media.findUnique({ where: { id } });
    if (!before) return res.redirect('/admin');
    const data = mediaData(req, before);
    const changed = videoChanged(before, data);
    if (changed) { data.probe = null; data.quality = null; clearDerived(id); }
    await prisma.media.update({ where: { id }, data });
    if (changed && data.path) queueAnalysis(id);
    res.redirect(`/admin/title/${id}?saved=1`);
}));

router.post('/title/:id(\\d+)/delete', page(async (req, res) => {
    const id = int(req.params.id);
    const m = await prisma.media.findUnique({ where: { id } });
    if (m) {
        const eps = await prisma.media.findMany({ where: { parentId: id }, select: { id: true } });
        for (const e of eps) clearDerived(e.id);
        await prisma.media.deleteMany({ where: { parentId: id } });
        await prisma.media.delete({ where: { id } });
        clearDerived(id);
    }
    res.redirect(m && m.type === 'episode' ? `/admin/title/${m.parentId}` : '/admin?flash=deleted');
}));

router.post('/title/:id(\\d+)/tmdb', page(async (req, res) => {
    const id = int(req.params.id);
    const type = req.body.tmdbType === 'series' || req.body.tmdbType === 'tv' ? 'series' : 'movie';
    try {
        await applyTmdb(id, type, int(req.body.tmdbId));
        res.redirect(`/admin/title/${id}?saved=1`);
    } catch (e) {
        res.redirect(`/admin/title/${id}?error=${encodeURIComponent(e.message)}`);
    }
}));

router.post('/title/:id(\\d+)/episodes/tmdb', page(async (req, res) => {
    const id = int(req.params.id);
    const m = await prisma.media.findUnique({ where: { id } });
    if (m && m.tmdbId) await fillEpisodesFromTmdb(id, m.tmdbId).catch(() => {});
    res.redirect(`/admin/title/${id}?saved=1`);
}));

router.post('/title/:id(\\d+)/analyze', page(async (req, res) => {
    const id = int(req.params.id);
    clearDerived(id);
    await prisma.media.update({ where: { id }, data: { probe: null } }).catch(() => {});
    queueAnalysis(id, { force: true });
    const eps = await prisma.media.findMany({ where: { parentId: id }, select: { id: true } });
    for (const e of eps) { clearDerived(e.id); queueAnalysis(e.id, { force: true }); }
    res.redirect(`/admin/title/${id}?saved=1`);
}));

// --- episodes ---
router.get('/title/:id(\\d+)/episode/new', page(async (req, res) => {
    const series = await prisma.media.findUnique({ where: { id: int(req.params.id) } });
    if (!series || series.type !== 'series') return res.redirect('/admin');
    const last = await prisma.media.findFirst({ where: { parentId: series.id }, orderBy: [{ season: 'desc' }, { order: 'desc' }] });
    const season = last ? (last.season || 1) : 1;
    await renderEditor(res, { id: null, type: 'episode', parentId: series.id, season, order: last ? last.order + 1 : 1, title: '' }, { isNew: true });
}));

router.post('/title/:id(\\d+)/episode/new', uploadFields, page(async (req, res) => {
    const series = await prisma.media.findUnique({ where: { id: int(req.params.id) } });
    if (!series) return res.redirect('/admin');
    const data = mediaData(req, { type: 'episode' });
    const ep = await prisma.media.create({ data: { ...data, type: 'episode', parentId: series.id, category: 'Episode' } });
    if (ep.path) queueAnalysis(ep.id);
    if (series.tmdbId && await tmdb.tmdbEnabled() && !str(req.body.title)) await fillEpisodesFromTmdb(series.id, series.tmdbId).catch(() => {});
    res.redirect(`/admin/title/${series.id}?saved=1#episodes`);
}));

// --- subtitles ---
router.post('/title/:id(\\d+)/subtitles', upload.single('subtitle'), page(async (req, res) => {
    const id = int(req.params.id);
    if (req.file) {
        const g = guessSubtitleInfo(req.file.originalname);
        const lang = str(req.body.lang) || g.lang;
        const label = str(req.body.label) || languageName(lang, 'en') || req.file.originalname;
        await prisma.subtitle.create({ data: { mediaId: id, lang, label, path: uploadPath(req.file) } });
    }
    res.redirect(`/admin/title/${id}?saved=1#subtitles`);
}));

router.post('/subtitles/:sid(\\d+)/delete', page(async (req, res) => {
    const s = await prisma.subtitle.findUnique({ where: { id: int(req.params.sid) } });
    if (s) {
        await prisma.subtitle.delete({ where: { id: s.id } });
        if (s.path.startsWith('/uploads/subtitles/')) {
            const loc = resolveMediaPath(s.path);
            if (loc && loc.file) fs.rm(loc.file, { force: true }, () => {});
        }
    }
    res.redirect(s ? `/admin/title/${s.mediaId}?saved=1#subtitles` : '/admin');
}));

// ------------------------------------------------------------ TMDB lookups
router.get('/api/tmdb/search', page(async (req, res) => {
    try {
        const results = await tmdb.search(str(req.query.q), { type: req.query.type || undefined, year: int(req.query.year) || undefined });
        res.json({ results: results.slice(0, 12) });
    } catch (e) { res.status(400).json({ error: e.message }); }
}));

// ------------------------------------------------------------ users
router.post('/user/add', upload.single('avatar'), page(async (req, res) => {
    const username = str(req.body.username);
    if (!username || !req.body.password) return res.redirect('/admin?tab=users&flash=missing');
    if (await prisma.user.findUnique({ where: { username } })) return res.redirect('/admin?tab=users&flash=taken');
    await prisma.user.create({
        data: {
            username,
            password: await bcrypt.hash(String(req.body.password), 10),
            role: req.body.role === 'admin' ? 'admin' : 'viewer',
            avatar: req.file ? uploadPath(req.file) : null
        }
    });
    res.redirect('/admin?tab=users&flash=saved');
}));

router.post('/user/edit', upload.single('avatar'), page(async (req, res) => {
    const id = int(req.body.id);
    const u = await prisma.user.findUnique({ where: { id } });
    if (!u || u.parentId) return res.redirect('/admin?tab=users');
    const data = { role: req.body.role === 'admin' ? 'admin' : 'viewer' };
    const username = str(req.body.username);
    if (username && username !== u.username) {
        if (await prisma.user.findUnique({ where: { username } })) return res.redirect('/admin?tab=users&flash=taken');
        data.username = username;
    }
    // never demote the last admin
    if (u.role === 'admin' && data.role !== 'admin' && await prisma.user.count({ where: { role: 'admin', parentId: null } }) <= 1) data.role = 'admin';
    if (req.body.password && String(req.body.password).trim()) data.password = await bcrypt.hash(String(req.body.password), 10);
    if (req.file) data.avatar = uploadPath(req.file);
    await prisma.user.update({ where: { id }, data });
    res.redirect('/admin?tab=users&flash=saved');
}));

router.post('/user/delete/:id(\\d+)', page(async (req, res) => {
    const id = int(req.params.id);
    const u = await prisma.user.findUnique({ where: { id } });
    const admins = await prisma.user.count({ where: { role: 'admin', parentId: null } });
    if (u && id !== req.user.id && !(u.role === 'admin' && admins <= 1)) await prisma.user.delete({ where: { id } });
    res.redirect('/admin?tab=users');
}));

// ------------------------------------------------------------ settings & system
router.post('/settings/update', page(async (req, res) => {
    const body = { ...req.body };
    // Keep stored secrets when the field is left blank.
    const current = await getSettings();
    for (const k of ['OIDC_CLIENT_SECRET', 'TMDB_API_KEY']) {
        if (body[k] !== undefined && !str(body[k]) && current[k] && body[k + '_CLEAR'] !== 'on') delete body[k];
        delete body[k + '_CLEAR'];
    }
    if (body.TRICKPLAY === undefined && body._form === 'playback') body.TRICKPLAY = 'false';
    delete body._form;
    await saveSettings(body);
    res.redirect('/admin?tab=settings&flash=saved');
}));

router.post('/system/rescan', page(async (req, res) => {
    const all = await prisma.media.findMany({ where: { path: { not: null } }, select: { id: true } });
    for (const m of all) queueAnalysis(m.id);
    res.redirect('/admin?tab=system&flash=queued');
}));

export default router;
