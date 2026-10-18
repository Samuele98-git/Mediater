// Video delivery: direct range streaming, live remux/transcode through ffmpeg,
// playback decisions, subtitles and scrubbing thumbnails. Works for library
// files, files still downloading over BitTorrent (admins only), and raw torrent
// previews (admins only).
import express from 'express';
import fs from 'fs';
import path from 'path';
import rangeParser from 'range-parser';
import prisma from '../lib/prisma.js';
import engine from '../lib/torrents.js';
import { CACHE_DIR } from '../lib/config.js';
import { INTERNAL_TOKEN, torrentLoopbackUrl } from '../lib/internal.js';
import { resolveMediaPath, videoMime } from '../lib/media-paths.js';
import { hasFfmpeg, hasFfprobe, probe, decidePlayback, spawnPlaybackStream, transcodeStats, extractSubtitleVtt, convertSubtitleToVtt, keyframeBefore } from '../lib/ffmpeg.js';
import { decodeSubtitle, toVtt, languageName, guessSubtitleInfo } from '../lib/subtitles.js';
import { getSettings, num } from '../lib/settings.js';
import { trickplayDir, isKidSafe } from '../lib/library.js';
import { isAuth, isAdmin, streamViewer } from '../middleware/auth.js';
import { isSubtitleFile } from '../lib/release-name.js';

const router = express.Router();
const MAX_TRANSCODES = parseInt(process.env.MAX_TRANSCODES || '4', 10);
const probeCache = new Map();
const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const UNAVAILABLE = 'This video is not available right now';

// Express 4 does not catch rejected promises: every async handler goes through this.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Positive 32-bit ids only (anything else would make the database throw).
const idParam = (v) => (/^\d{1,10}$/.test(String(v)) && Number(v) > 0 && Number(v) <= 2147483647 ? Number(v) : null);
const indexParam = (v) => (/^\d{1,6}$/.test(String(v)) ? Number(v) : null);

const viewer = [isAuth, streamViewer];
const adminOnly = [isAuth, isAdmin];

// ------------------------------------------------------------ access
/** Kids profiles only get kid-safe titles; titles still downloading are for admins only. */
async function canWatch(req, m) {
    if (req.viewer && req.viewer.kids) {
        const title = m.type === 'episode' && m.parentId ? await prisma.media.findUnique({ where: { id: m.parentId } }) : m;
        if (!title || !isKidSafe(title)) return false;
    }
    if (!(req.viewer && req.viewer.admin) && m.torrentId != null && m.fileIndex != null && engine.enabled) {
        const fi = engine.fileInfo(m.torrentId, m.fileIndex);
        if (fi && !fi.complete) return false;
    }
    return true;
}

// ------------------------------------------------------------ sources
async function mediaSource(req, id) {
    if (id == null) return null;
    const m = await prisma.media.findUnique({ where: { id } });
    if (!m || !m.path || !(await canWatch(req, m))) return null;
    if (m.torrentId != null && m.fileIndex != null && engine.enabled) {
        const fi = engine.fileInfo(m.torrentId, m.fileIndex);
        if (fi && !fi.complete) {
            return { type: 'torrent', tid: m.torrentId, fileIndex: m.fileIndex, size: fi.length, name: fi.name, media: m, key: `m/${m.id}`, probeKey: `t:${fi.row.infoHash}:${m.fileIndex}` };
        }
    }
    const loc = resolveMediaPath(m.path);
    if (!loc) return null;
    if (loc.kind === 'url') return { type: 'url', url: loc.url, name: m.title, media: m, key: `m/${m.id}`, probeKey: `m:${m.id}` };
    let stat;
    try { stat = fs.statSync(loc.file); } catch { return null; }
    return { type: 'file', file: loc.file, size: stat.size, name: path.basename(loc.file), media: m, key: `m/${m.id}`, probeKey: `m:${m.id}:${stat.size}` };
}

function torrentSource(tid, fileIndex) {
    if (tid == null || fileIndex == null) return null;
    const fi = engine.fileInfo(tid, fileIndex);
    if (!fi) return null;
    if (fi.complete && fs.existsSync(fi.abs)) {
        return { type: 'file', file: fi.abs, size: fi.length, name: fi.name, key: `t/${tid}/${fileIndex}`, probeKey: `t:${fi.row.infoHash}:${fileIndex}` };
    }
    return { type: 'torrent', tid, fileIndex, size: fi.length, name: fi.name, key: `t/${tid}/${fileIndex}`, probeKey: `t:${fi.row.infoHash}:${fileIndex}` };
}
const torrentSourceOf = (req) => torrentSource(idParam(req.params.tid), indexParam(req.params.fi));

const loopbackUrl = (src) => torrentLoopbackUrl(src.tid, src.fileIndex);
const ffmpegInput = (src) => (src.type === 'file' ? src.file : src.type === 'url' ? src.url : loopbackUrl(src));

async function getProbe(src) {
    if (src.type === 'file' && src.media && src.media.probe) {
        const cached = safeJson(src.media.probe);
        if (cached) return cached;
    }
    if (probeCache.has(src.probeKey)) return probeCache.get(src.probeKey);
    if (!hasFfprobe()) return null;
    const p = probe(ffmpegInput(src), { timeoutMs: src.type === 'torrent' ? 120000 : 45000 })
        .then(info => {
            if (src.type === 'file' && src.media) {
                const data = { probe: JSON.stringify(info) };
                if (!src.media.duration && info.duration) data.duration = Math.max(1, Math.round(info.duration / 60));
                prisma.media.update({ where: { id: src.media.id }, data }).catch(() => {});
            }
            return info;
        })
        .catch(e => { probeCache.delete(src.probeKey); throw e; });
    probeCache.set(src.probeKey, p);
    if (probeCache.size > 300) probeCache.delete(probeCache.keys().next().value);
    return p;
}

// ------------------------------------------------------------ byte serving
async function serveTorrentRange(req, res, src, { resume }) {
    let closed = false;
    res.on('close', () => { closed = true; });
    const size = src.size;
    let start = 0, end = size - 1, status = 200;
    if (req.headers.range) {
        const ranges = rangeParser(size, req.headers.range, { combine: true });
        if (ranges === -1) return res.status(416).set('Content-Range', `bytes */${size}`).end();
        if (Array.isArray(ranges) && ranges.length) { start = ranges[0].start; end = ranges[0].end; status = 206; }
    }
    const headers = () => {
        res.status(status).set({
            'Accept-Ranges': 'bytes', 'Content-Type': videoMime(src.name),
            'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store'
        });
        if (status === 206) res.set('Content-Range', `bytes ${start}-${end}/${size}`);
    };
    if (req.method === 'HEAD') { headers(); return res.end(); }
    let stream;
    try {
        stream = await engine.createStream(src.tid, src.fileIndex, start, end, { resume });
    } catch {
        if (!closed && !res.headersSent) res.status(503).json({ error: UNAVAILABLE });
        return;
    }
    if (closed) { stream.destroy(); return; }
    headers();
    res.on('close', () => { try { stream.destroy(); } catch { /* ignore */ } });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
}

function serveDirect(req, res, src, { resume = true } = {}) {
    if (src.type === 'url') return res.redirect(src.url);
    if (src.type === 'torrent') return serveTorrentRange(req, res, src, { resume });
    res.type(videoMime(src.name));
    res.set('Cache-Control', 'private, max-age=0');
    return res.sendFile(src.file, { acceptRanges: true, dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) res.status(err.status || 500).end();
    });
}

async function serveTranscode(req, res, src) {
    if (!hasFfmpeg()) return res.status(501).json({ error: 'ffmpeg is not installed on the server' });
    // Watch for the player going away (seek, back button) before any slow step,
    // so no ffmpeg process is ever started for nobody.
    let closed = false;
    res.on('close', () => { closed = true; });
    if (transcodeStats().active >= MAX_TRANSCODES) return res.status(503).json({ error: 'Too many streams are being converted right now' });
    if (src.type === 'torrent') {
        try { await engine.ensureActive(src.tid, { resume: true }); } catch {
            if (!closed) res.status(503).json({ error: UNAVAILABLE });
            return;
        }
    }
    let info = null;
    try { info = await getProbe(src); } catch { /* transcode anyway */ }
    const settings = await getSettings();
    if (closed) return;
    if (transcodeStats().active >= MAX_TRANSCODES) return res.status(503).json({ error: 'Too many streams are being converted right now' });
    const mode = req.query.mode === 'transcode' ? 'transcode' : 'remux';
    const audio = req.query.audio !== undefined && req.query.audio !== '' ? indexParam(req.query.audio) : null;
    const proc = spawnPlaybackStream(ffmpegInput(src), {
        start: Math.max(0, parseFloat(req.query.start) || 0),
        mode,
        audioIndex: audio,
        copyAudio: req.query.ac === 'copy',
        videoCodec: info && info.video ? info.video.codec : '',
        maxHeight: Math.max(360, num(settings.TRANSCODE_MAX_HEIGHT, 1080))
    });
    res.status(200).set({ 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const kill = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } };
    res.on('close', kill);
    proc.on('error', () => res.destroy());
    proc.stdout.pipe(res);
}

// ------------------------------------------------------------ routes
const mediaId = (req) => idParam(req.params.id);

router.get(['/stream/m/:id', '/stream/:id(\\d+)'], viewer, ah(async (req, res) => {
    const src = await mediaSource(req, mediaId(req));
    if (!src) return res.status(404).end();
    // Pressing play on a paused download resumes it (admins only get here for those).
    return serveDirect(req, res, src, { resume: true });
}));
router.get('/stream/m/:id/transcode', viewer, ah(async (req, res) => {
    const src = await mediaSource(req, mediaId(req));
    if (!src) return res.status(404).end();
    return serveTranscode(req, res, src);
}));
router.get('/stream/t/:tid/:fi', adminOnly, ah(async (req, res) => {
    const src = torrentSourceOf(req);
    if (!src) return res.status(404).end();
    return serveDirect(req, res, src, { resume: true });
}));
router.get('/stream/t/:tid/:fi/transcode', adminOnly, ah(async (req, res) => {
    const src = torrentSourceOf(req);
    if (!src) return res.status(404).end();
    return serveTranscode(req, res, src);
}));
router.get('/stream/trailer/:id', viewer, ah(async (req, res) => {
    const id = mediaId(req);
    const m = id && await prisma.media.findUnique({ where: { id } });
    if (!m || !(await canWatch(req, m))) return res.status(404).end();
    const loc = resolveMediaPath(m.trailerUrl);
    if (!loc) return res.status(404).end();
    if (loc.kind === 'url') return res.redirect(loc.url);
    res.type(videoMime(loc.file));
    res.sendFile(loc.file, { acceptRanges: true }, err => { if (err && !res.headersSent) res.status(404).end(); });
}));

// ffmpeg reads torrents through this route. It is mounted on the internal
// loopback-only server (see server.js), never on the public app.
export const internalRouter = express.Router();
internalRouter.get('/internal/t/:tid/:fi', (req, res) => {
    if (typeof req.query.k !== 'string' || req.query.k !== INTERNAL_TOKEN) return res.status(403).end();
    const src = torrentSourceOf(req);
    if (!src) return res.status(404).end();
    // background jobs must never wake up a paused download
    Promise.resolve(serveDirect(req, res, src, { resume: false })).catch(() => res.destroy());
});

// ------------------------------------------------------------ playback info
function audioLabel(a, lang) {
    const name = languageName(a.lang, lang) || a.title || `Track ${a.n + 1}`;
    const ch = a.channels >= 6 ? ` ${a.channels === 8 ? '7.1' : '5.1'}` : '';
    const extra = a.title && name !== a.title && !a.title.toLowerCase().includes(name.toLowerCase()) ? ` – ${a.title}` : '';
    return name + ch + extra;
}

async function subtitleTracks(src, info, lang) {
    const out = [];
    if (src.media) {
        const subs = await prisma.subtitle.findMany({ where: { mediaId: src.media.id }, orderBy: { id: 'asc' } });
        for (const s of subs) out.push({ id: `s${s.id}`, lang: s.lang, label: languageName(s.lang, lang) || s.label, url: `/subs/s/${s.id}.vtt`, forced: /forced/i.test(s.label) });
    }
    if (src.type === 'torrent' || (src.key.startsWith('t/') && !src.media)) {
        const tid = src.tid ?? parseInt(src.key.split('/')[1], 10);
        const fi = src.fileIndex ?? parseInt(src.key.split('/')[2], 10);
        const row = engine.rows.get(tid);
        const files = row ? safeJson(row.files) || [] : [];
        const me = files[fi];
        if (me && !src.media) {
            const dir = path.posix.dirname(me.path);
            for (const f of files) {
                if (!isSubtitleFile(f.name) || path.posix.dirname(f.path) !== dir) continue;
                const g = guessSubtitleInfo(f.name);
                out.push({ id: `t${f.index}`, lang: g.lang, label: languageName(g.lang, lang) || f.name, url: `/subs/t/${tid}/${f.index}.vtt`, forced: g.forced });
            }
        }
    }
    // Embedded text tracks are only offered once the file is fully on disk.
    if (info && src.type !== 'torrent' && hasFfmpeg()) {
        for (const s of info.subs.filter(x => x.text)) {
            out.push({
                id: `e${s.index}`, lang: s.lang, forced: s.forced,
                label: (languageName(s.lang, lang) || s.title || `Track ${s.index}`) + (s.forced ? ' (Forced)' : ''),
                url: `/subs/e/${src.key}/${s.index}.vtt`
            });
        }
    }
    return out;
}

async function playbackInfo(req, res, src, { admin }) {
    const caps = new Set(String(req.query.caps || 'h264,aac,mp3').split(',').map(s => s.trim()).filter(Boolean));
    const lang = res.locals.lang || 'en';
    let info = null;
    try { info = await getProbe(src); } catch (e) { console.warn(`[playback] probe ${src.key}: ${e.message}`); }
    const audioIndex = req.query.audio !== undefined && req.query.audio !== '' ? indexParam(req.query.audio) : null;
    let decision = info ? decidePlayback(info, caps, { audioIndex }) : { mode: 'direct', audioIndex: null, copyAudio: false };
    if (req.query.force === 'remux' && decision.mode === 'direct') decision = { ...decision, mode: 'remux' };
    if (req.query.force === 'transcode') decision = { ...decision, mode: 'transcode', copyAudio: false };
    if (src.type === 'url' && decision.mode !== 'direct' && !hasFfmpeg()) decision.mode = 'direct';
    let warning = null;
    if (decision.mode !== 'direct' && !hasFfmpeg()) { warning = 'ffmpeg-missing'; decision.mode = 'direct'; }

    const base = `/stream/${src.key}`;
    const qs = new URLSearchParams({ mode: decision.mode });
    if (decision.audioIndex != null) qs.set('audio', decision.audioIndex);
    if (decision.copyAudio) qs.set('ac', 'copy');
    const url = decision.mode === 'direct' ? base : `${base}/transcode?${qs}&start=`;

    let trickplay = null;
    if (src.media) {
        const manifest = path.join(trickplayDir(src.media.id), 'manifest.json');
        if (fs.existsSync(manifest)) {
            trickplay = safeJson(fs.readFileSync(manifest, 'utf8'));
            if (trickplay) trickplay.base = `/trickplay/${src.media.id}/`;
        }
    }
    // Download details are for the admin only: everyone else just watches.
    let torrent = null;
    if (admin && src.type === 'torrent') {
        const fi = engine.fileInfo(src.tid, src.fileIndex);
        const d = engine.describe(src.tid, { withFiles: false });
        torrent = { id: src.tid, fileIndex: src.fileIndex, status: d && d.status, progress: fi && fi.live ? undefined : (d && d.progress) };
    }
    res.json({
        mode: decision.mode, url, warning,
        duration: (info && info.duration) || (src.media && src.media.duration ? src.media.duration * 60 : null),
        video: info && info.video ? { codec: info.video.codec, width: info.video.width, height: info.video.height, hdr: info.video.hdr } : null,
        audioIndex: decision.audioIndex,
        audioTracks: info ? info.audio.map(a => ({ index: a.index, label: audioLabel(a, lang), lang: a.lang, codec: a.codec, channels: a.channels })) : [],
        subtitles: await subtitleTracks(src, info, lang),
        trickplay, torrent
    });
}

/**
 * Where a remux (stream copy) seek to `t` really starts: the keyframe at or before
 * it (`start`, for the player's clock) and the position to ask ffmpeg for (`from`).
 * ffmpeg seeks ~0.13 s early on files with B-frames, so asking for the keyframe
 * itself would land one keyframe earlier: ask for a point just after it instead.
 */
async function keyframeInfo(req, res, src) {
    const t = Math.max(0, parseFloat(req.query.t) || 0);
    let start = t, from = t;
    if (t > 0 && hasFfprobe() && src.type !== 'url') {
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        const kf = await keyframeBefore(ffmpegInput(src), t, { timeoutMs: src.type === 'torrent' ? 20000 : 8000, signal: ac.signal });
        if (kf != null && kf <= t + 0.05 && kf >= t - 60) { start = kf; from = kf + 0.2; }
    }
    if (!res.headersSent && !res.destroyed) res.json({ start, from });
}

router.get('/api/playback/m/:id', viewer, ah(async (req, res) => {
    const src = await mediaSource(req, mediaId(req));
    if (!src) return res.status(404).json({ error: 'This title has no playable video yet.' });
    return playbackInfo(req, res, src, { admin: req.viewer.admin });
}));
router.get('/api/playback/m/:id/keyframe', viewer, ah(async (req, res) => {
    const src = await mediaSource(req, mediaId(req));
    if (!src) return res.status(404).json({ error: 'Not found' });
    return keyframeInfo(req, res, src);
}));
router.get('/api/playback/t/:tid/:fi', adminOnly, ah(async (req, res) => {
    const src = torrentSourceOf(req);
    if (!src) return res.status(404).json({ error: 'File not found' });
    return playbackInfo(req, res, src, { admin: true });
}));
router.get('/api/playback/t/:tid/:fi/keyframe', adminOnly, ah(async (req, res) => {
    const src = torrentSourceOf(req);
    if (!src) return res.status(404).json({ error: 'File not found' });
    return keyframeInfo(req, res, src);
}));

// Lightweight "Downloading 34% · 2 MB/s" status for the player (admins).
function downloadStatus(tid, fileIndex) {
    const fi = tid != null && fileIndex != null ? engine.fileInfo(tid, fileIndex) : null;
    if (!fi) return { active: false };
    const d = engine.describe(tid, { withFiles: false }) || {};
    return {
        active: !fi.complete, progress: fi.progress, status: d.status,
        downloadSpeed: d.downloadSpeed || 0, peers: d.peers || 0
    };
}
router.get('/api/download-status/m/:id', viewer, ah(async (req, res) => {
    const id = mediaId(req);
    if (!req.viewer.admin || id == null) return res.json({ active: false });
    const m = await prisma.media.findUnique({ where: { id }, select: { torrentId: true, fileIndex: true } });
    if (!m || m.torrentId == null || m.fileIndex == null || !engine.enabled) return res.json({ active: false });
    res.json(downloadStatus(m.torrentId, m.fileIndex));
}));
router.get('/api/download-status/t/:tid/:fi', adminOnly, (req, res) => {
    res.json(downloadStatus(idParam(req.params.tid), indexParam(req.params.fi)));
});

// ------------------------------------------------------------ subtitles
function sendVtt(res, text) {
    res.set({ 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=300' });
    res.send(text);
}

async function readTorrentFile(tid, fi, maxBytes = 5 * 1024 * 1024) {
    const info = engine.fileInfo(tid, fi);
    if (!info) throw new Error('not found');
    if (info.complete && fs.existsSync(info.abs)) return fs.readFileSync(info.abs);
    if (info.length > maxBytes) throw new Error('too large');
    const stream = await engine.createStream(tid, fi, 0, info.length - 1, { resume: true });
    const chunks = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
}

async function subtitleBytesToVtt(buf, name, fileForFfmpeg) {
    const ext = path.extname(name).toLowerCase();
    if (ext === '.ass' || ext === '.ssa') {
        if (!fileForFfmpeg || !hasFfmpeg()) throw new Error('ASS subtitles need ffmpeg');
        return convertSubtitleToVtt(fileForFfmpeg);
    }
    return toVtt(decodeSubtitle(buf));
}

router.get('/subs/s/:id.vtt', viewer, ah(async (req, res) => {
    const id = idParam(req.params.id);
    const s = id && await prisma.subtitle.findUnique({ where: { id }, include: { media: true } });
    if (!s || !s.media || !(await canWatch(req, s.media))) return res.status(404).end();
    try {
        const loc = resolveMediaPath(s.path);
        if (loc && loc.kind === 'url') {
            const r = await fetch(loc.url, { signal: AbortSignal.timeout(15000) });
            return sendVtt(res, toVtt(decodeSubtitle(Buffer.from(await r.arrayBuffer()))));
        }
        let buf = null;
        if (loc && fs.existsSync(loc.file) && fs.statSync(loc.file).size > 0) buf = fs.readFileSync(loc.file);
        // Still downloading? Fetch it straight from the swarm.
        if (!buf && s.path.startsWith('dl:') && s.media.torrentId) {
            const row = engine.rows.get(s.media.torrentId);
            const f = row && (safeJson(row.files) || []).find(x => 'dl:' + x.disk === s.path);
            if (f) buf = await readTorrentFile(row.id, f.index);
        }
        if (!buf) return res.status(404).end();
        sendVtt(res, await subtitleBytesToVtt(buf, s.path, loc && loc.file));
    } catch (e) {
        res.status(500).send('WEBVTT\n\n');
    }
}));

router.get('/subs/t/:tid/:fi.vtt', adminOnly, ah(async (req, res) => {
    const tid = idParam(req.params.tid), fi = indexParam(req.params.fi);
    try {
        const info = tid != null && fi != null ? engine.fileInfo(tid, fi) : null;
        if (!info) return res.status(404).end();
        sendVtt(res, await subtitleBytesToVtt(await readTorrentFile(tid, fi), info.name, info.complete ? info.abs : null));
    } catch (e) { res.status(500).send('WEBVTT\n\n'); }
}));

const extracting = new Map();
async function embeddedSubtitle(req, res, src) {
    if (!src || src.type === 'torrent') return res.status(404).end();
    const idx = indexParam(req.params.idx);
    if (idx == null) return res.status(404).end();
    const cacheFile = path.join(CACHE_DIR, 'subs', `${src.probeKey.replace(/[^a-z0-9]+/gi, '_')}_${idx}.vtt`);
    try {
        if (!fs.existsSync(cacheFile)) {
            if (!extracting.has(cacheFile)) {
                extracting.set(cacheFile, extractSubtitleVtt(ffmpegInput(src), idx).then(vtt => {
                    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
                    fs.writeFileSync(cacheFile, vtt);
                }).finally(() => extracting.delete(cacheFile)));
            }
            await extracting.get(cacheFile);
        }
        sendVtt(res, fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
        res.status(500).send('WEBVTT\n\n');
    }
}
router.get('/subs/e/m/:id/:idx.vtt', viewer, ah(async (req, res) => embeddedSubtitle(req, res, await mediaSource(req, mediaId(req)))));
router.get('/subs/e/t/:tid/:fi/:idx.vtt', adminOnly, ah(async (req, res) => embeddedSubtitle(req, res, torrentSourceOf(req))));

// ------------------------------------------------------------ trickplay
router.get('/trickplay/:id/:file', viewer, ah(async (req, res) => {
    const id = mediaId(req);
    if (id == null || !/^(sprite_\d{3}\.jpg|manifest\.json)$/.test(req.params.file)) return res.status(404).end();
    const m = await prisma.media.findUnique({ where: { id } });
    if (!m || !(await canWatch(req, m))) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(trickplayDir(id), req.params.file), err => { if (err && !res.headersSent) res.status(404).end(); });
}));

export default router;
