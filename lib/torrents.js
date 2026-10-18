// BitTorrent engine (WebTorrent) with database-backed state.
//
// Downloads are download-only: peers are never unchoked, piece requests are
// never answered and we never advertise the pieces we have, so nothing is ever
// uploaded or shared. When a movie or show finishes it is added to the library,
// disconnected from the swarm and dropped from the Downloads list (its files
// stay on disk and play from there). "Just download" items stay listed as
// completed.
//
// Lifecycle of a torrent row:
//   metadata    -> waiting for the file list from peers
//   pending     -> file list known, nothing selected yet (user reviews / previews)
//   downloading -> selected files downloading (streamable meanwhile)
//   completed   -> finished and disconnected ("Just download" items, or a failed import)
//   paused      -> stopped by the user (files kept, resumes where it left off)
//   error       -> something went wrong (message in `error`)
import WebTorrent from 'webtorrent';
import FSChunkStore from 'fs-chunk-store';
import parseTorrent, { toMagnetURI } from 'parse-torrent';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import path from 'path';
import prisma from './prisma.js';
import { DOWNLOAD_DIR, TORRENT_FILE_DIR, TORRENT_PORT, TORRENTS_ENABLED } from './config.js';
import { getSettings, settingsEvents, num } from './settings.js';
import { isVideoFile, isSubtitleFile, isSampleFile, isArtworkFile, isExecutableFile, parseRelease, detectEpisodes } from './release-name.js';
import { importTorrent, queueAnalysis, applyTorrentArtwork } from './library.js';
import { torrentLoopbackUrl } from './internal.js';
import { hasFfmpeg } from './ffmpeg.js';

const ACTIVE = new Set(['metadata', 'pending', 'downloading']);
const RESERVED = /[<>:"/\\|?*\u0000-\u001F]/g;
const DEFAULT_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://explodie.org:6969/announce'
];
const MAX_TORRENT_FILE = 15 * 1024 * 1024;

const safeJson = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

// Parsed file lists, cached per row object (rows are replaced on every update).
const filesCache = new WeakMap();
function filesOf(row) {
    if (!row) return [];
    let f = filesCache.get(row);
    if (!f) { f = safeJson(row.files, []); filesCache.set(row, f); }
    return f;
}

const IS_WIN = process.platform === 'win32';
// fs-chunk-store strips reserved characters from file names only; on Windows a
// folder like "Mission: Impossible Pack" can't be created either, so clean those too.
const safeDir = (s) => (IS_WIN ? (s.replace(RESERVED, '').replace(/[. ]+$/, '') || '_') : s);

/** Path of a torrent file on disk, relative to DOWNLOAD_DIR (the same rule the store uses). */
export function diskRelPath(filePath) {
    const parts = String(filePath).split(IS_WIN ? /[\\/]+/ : /\/+/).filter(Boolean);
    const base = (parts.pop() || '').replace(RESERVED, '');
    return [...parts.map(safeDir), base].join('/');
}

/** WebTorrent's file store, with folder names that work on every OS. */
export class DownloadStore extends FSChunkStore {
    constructor(chunkLength, opts = {}) {
        if (IS_WIN && Array.isArray(opts.files)) {
            opts = { ...opts, files: opts.files.map(f => ({ path: diskRelPath(f.path), length: f.length, offset: f.offset })) };
        }
        super(chunkLength, opts);
    }
}

function fileList(t) {
    return t.files.map((f, index) => ({
        index, name: f.name, path: f.path.split(path.sep).join('/'), length: f.length, disk: diskRelPath(f.path)
    }));
}

const absPath = (f) => path.join(DOWNLOAD_DIR, f.disk || diskRelPath(f.path));
const fileComplete = (f) => { try { return f.length > 0 && fs.statSync(absPath(f)).size === f.length; } catch { return false; } };
const samePathKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/**
 * Download-only peer connection: we never unchoke anyone, never send piece data,
 * never tell peers which pieces we have and don't even hand out the torrent's
 * file list, so nothing is ever shared.
 */
function leechOnly(wire) {
    wire.unchoke = () => {};
    wire.allowedFast = () => {};
    wire.piece = () => {};
    wire.have = () => {};
    wire.haveAll = function () { if (this.hasFast) this.haveNone(); };
    wire.bitfield = function () { if (this.hasFast) this.haveNone(); };
    if (wire.ut_metadata && typeof wire.ut_metadata._reject === 'function') {
        wire.ut_metadata._onRequest = function (piece) { this._reject(piece); };
    }
}

/** Passes on at most `bytes` bytes of `src` (WebTorrent reads to the end of the file when asked for `end: 0`). */
function limitBytes(src, bytes) {
    let left = bytes;
    const out = new PassThrough();
    src.on('data', (chunk) => {
        if (left <= 0) return;
        const c = chunk.length > left ? chunk.subarray(0, left) : chunk;
        left -= c.length;
        if (!out.write(c)) src.pause();
        if (left <= 0) { out.end(); src.destroy(); }
    });
    out.on('drain', () => src.resume());
    src.on('end', () => out.end());
    src.on('error', (e) => out.destroy(e));
    out.on('close', () => src.destroy());
    return out;
}

/** Downloads a .torrent file from a link (indexers often redirect to a magnet link instead). */
async function fetchTorrentSource(url) {
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
        if (/^magnet:/i.test(current)) return current;
        if (!/^https?:\/\//i.test(current)) throw new Error('Only http(s) links to .torrent files are supported');
        const get = () => fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/x-bittorrent, */*' } });
        // one retry: busy sites (archive.org…) sometimes fail once
        let res;
        try { res = await get(); } catch { res = null; }
        if (!res || res.status >= 500) {
            await new Promise(r => setTimeout(r, 1500));
            try { res = await get(); } catch { throw new Error(`Could not reach ${new URL(current).hostname}, try again in a moment`); }
        }
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) { current = new URL(loc, current).href; continue; }
        if (!res.ok) throw new Error(`Could not download the .torrent file (HTTP ${res.status})`);
        if (Number(res.headers.get('content-length') || 0) > MAX_TORRENT_FILE) throw new Error('.torrent file is too large');
        const chunks = [];
        let size = 0;
        for await (const c of res.body) {
            size += c.length;
            if (size > MAX_TORRENT_FILE) throw new Error('.torrent file is too large');
            chunks.push(Buffer.from(c));
        }
        return Buffer.concat(chunks);
    }
    throw new Error('Too many redirects');
}

// Which version of a movie to keep when a torrent has several (Internet Archive items
// ship the original plus 1080p/720p/DVD/phone copies): the highest resolution named
// in the file, in a format browsers play directly, never a phone or low-bitrate copy;
// the bigger file wins a tie.
const QUALITY_RANK = { '4K': 4, '1080p': 3, '720p': 2, '576p': 1.5, '480p': 1 };
const LOW_COPY_RE = /_512kb|[_\-. ](ipod|iphone|psp|ps3|mobile|lowres)(?=[_\-. ]|$)/i;
function versionScore(f) {
    let s = QUALITY_RANK[parseRelease(f.name).quality] || 1.2;
    if (/\.(mp4|m4v|mkv|webm|mov)$/i.test(f.name)) s += 0.5;
    if (LOW_COPY_RE.test(path.basename(f.name).replace(/\.[^.]+$/, ''))) s -= 2;
    return s;
}

/**
 * What to download by default: videos (minus samples), subtitles and artwork —
 * never program files. A movie that comes in several versions (Internet Archive
 * items ship the original plus smaller copies) keeps only the best one.
 */
export function defaultSelection(files, kind = null) {
    const safe = files.filter(f => !isExecutableFile(f.name));
    let vids = safe.filter(f => isVideoFile(f.name) && !isSampleFile(f.name, f.length));
    if (!vids.length) return safe.map(f => f.index);
    if (kind === 'movie' && vids.length > 1 && detectEpisodes(vids).length < 2) {
        const pick = (a, b) => { const sa = versionScore(a), sb = versionScore(b); return sb > sa || (sb === sa && b.length > a.length) ? b : a; };
        vids = [vids.reduce(pick)];
    }
    const keep = new Set(vids.map(f => f.index));
    return safe.filter(f => keep.has(f.index) || isSubtitleFile(f.name) || isArtworkFile(f.name, f.length)).map(f => f.index);
}

export function guessKind(name, files) {
    const vids = files.filter(f => isVideoFile(f.name) && !isSampleFile(f.name, f.length));
    if (!vids.length) return 'other';
    const p = parseRelease(name);
    if (detectEpisodes(vids).length >= 2) return 'series';
    if (p.season != null || p.episode != null) return 'series';
    return 'movie';
}

class TorrentEngine extends EventEmitter {
    constructor() {
        super();
        this.client = null;
        this.disabledReason = null;
        this.rows = new Map();      // id -> db row (cache)
        this.handles = new Map();   // id -> WebTorrent torrent
        this.autoStart = new Map(); // id -> start options once metadata arrives
        this.mediaByTorrent = new Map(); // id -> [{ id, title, type }]
        this.closing = new Set();   // ids being paused / removed: nothing may re-attach them meanwhile
        this.finishing = new Set();
        this.retired = new Map();   // finished rows dropped from the list (ffmpeg may still be reading them)
        this.recent = [];           // recently finished, for the Downloads page
        this.ticks = 0;
        this.ticking = false;
        this.setMaxListeners(100);
    }

    get enabled() { return !!this.client && !this.client.destroyed; }

    async init() {
        if (!TORRENTS_ENABLED) { this.disabledReason = 'Disabled with TORRENTS_ENABLED=false'; return; }
        try {
            const s = await getSettings();
            this.client = new WebTorrent({
                torrentPort: TORRENT_PORT,
                dhtPort: parseInt(process.env.DHT_PORT || '0', 10) || 0,
                // No WebRTC (browser) peers: regular TCP/uTP swarms only. In Node their
                // connections can fail in ways that crash the process.
                tracker: { wrtc: false },
                maxConns: Math.max(10, num(s.TORRENT_MAX_CONNS, 55)),
                natUpnp: (process.env.TORRENT_UPNP || 'true') !== 'false',
                natPmp: (process.env.TORRENT_UPNP || 'true') !== 'false'
            });
        } catch (e) {
            this.disabledReason = e.message;
            console.error('[torrents] could not start client:', e.message);
            return;
        }
        let utp = this.client.utp;
        this.client.on('error', (err) => {
            const msg = (err && err.message) || String(err);
            if (utp && this.client && !this.client.utp) {
                utp = false;
                console.warn(`[torrents] uTP unavailable (${msg}) — continuing over TCP`);
            } else if (this.client && this.client.destroyed) {
                this.disabledReason = msg;
                console.error(`[torrents] client stopped: ${msg}${/EADDRINUSE/.test(msg) ? ' (is TORRENT_PORT already used by another app?)' : ''}`);
            } else {
                console.warn('[torrents] client warning:', msg);
            }
        });
        this.applySettings(await getSettings());
        settingsEvents.on('change', s => this.applySettings(s));

        for (const r of await prisma.torrent.findMany({ orderBy: { id: 'asc' } })) this.rows.set(r.id, r);
        await this._refreshMediaLinks();
        for (const r of [...this.rows.values()]) {
            // Older versions kept finished downloads seeding and listed: retire them now.
            const finished = r.status === 'seeding' || r.status === 'completed';
            if (finished && r.kind !== 'other' && (this.mediaByTorrent.get(r.id) || []).length) { await this._forget(r.id); continue; }
            if (r.status === 'seeding') { await this._update(r.id, { status: 'completed' }); continue; }
            if (ACTIVE.has(r.status)) {
                try { this._attach(r); } catch (e) { await this._fail(r.id, e); }
            }
        }
        this.timer = setInterval(() => this._tick().catch(e => console.warn('[torrents] tick:', e.message)), 1000);
        this.timer.unref();
        console.log(`[torrents] engine ready, download-only (${this.rows.size} torrent${this.rows.size === 1 ? '' : 's'})`);
    }

    applySettings(s) {
        if (!this.client) return;
        const down = num(s.TORRENT_DOWNLOAD_LIMIT, 0);
        this.client.throttleDownload(down > 0 ? down * 1024 : -1);
    }

    async shutdown() {
        clearInterval(this.timer);
        await this._persistAll().catch(() => {});
        if (this.client) await new Promise(r => this.client.destroy(() => r()));
    }

    // ------------------------------------------------------------ adding
    async add({ magnet, buffer, url, addedById = null, start = null }) {
        if (!this.enabled) throw new Error(this.disabledReason || 'Torrent client is not running');
        let source = magnet ? String(magnet).trim() : buffer;
        if (url) source = await fetchTorrentSource(String(url).trim());
        if (!source) throw new Error('Provide a magnet link or a .torrent file');
        if (typeof source === 'string' && /^[a-f0-9]{40}$/i.test(source)) source = 'magnet:?xt=urn:btih:' + source;

        let parsed;
        try { parsed = await parseTorrent(source); } catch { throw new Error('That does not look like a valid magnet link or .torrent file'); }
        if (!parsed || !parsed.infoHash) throw new Error('Invalid torrent');

        const existing = await prisma.torrent.findUnique({ where: { infoHash: parsed.infoHash } });
        if (existing) {
            if (existing.status === 'error') await this.resume(existing.id);
            return { row: this.rows.get(existing.id) || existing, duplicate: true };
        }
        // A finished download that was dropped from the list may still be shutting down.
        const stale = await this.client.get(parsed.infoHash);
        if (stale) await new Promise(r => { try { this.client.remove(stale, { destroyStore: false }, () => r()); } catch { r(); } setTimeout(r, 5000); });

        let torrentFile = null;
        if (Buffer.isBuffer(source)) {
            torrentFile = parsed.infoHash + '.torrent';
            fs.writeFileSync(path.join(TORRENT_FILE_DIR, torrentFile), source);
        }
        const magnetURI = typeof source === 'string' ? source : toMagnetURI({
            infoHash: parsed.infoHash, name: parsed.name, announce: (parsed.announce || []).slice(0, 10)
        });
        const row = await prisma.torrent.create({
            data: {
                infoHash: parsed.infoHash,
                name: String(parsed.name || parsed.dn || parsed.infoHash).slice(0, 500),
                magnetURI, torrentFile, status: 'metadata', addedById
            }
        });
        this.rows.set(row.id, row);
        if (start) this.autoStart.set(row.id, start);
        this._attach(row);
        this.emit('change', row.id);
        return { row, duplicate: false };
    }

    _source(row) {
        if (row.torrentFile) {
            const p = path.join(TORRENT_FILE_DIR, row.torrentFile);
            if (fs.existsSync(p)) return fs.readFileSync(p);
        }
        return row.magnetURI || ('magnet:?xt=urn:btih:' + row.infoHash);
    }

    _attach(row) {
        if (this.handles.has(row.id)) return this.handles.get(row.id);
        if (this.closing.has(row.id)) throw new Error('This download is stopping');
        const t = this.client.add(this._source(row), {
            path: DOWNLOAD_DIR,
            deselect: true,
            announce: DEFAULT_TRACKERS,
            strategy: 'sequential',
            store: DownloadStore,
            uploads: 0 // no upload slots: peers are never unchoked
        });
        this.handles.set(row.id, t);
        t._mediaterId = row.id;
        t.on('wire', leechOnly);
        t.on('metadata', () => this._onMetadata(row.id, t).catch(e => this._fail(row.id, e)));
        t.on('error', err => this._fail(row.id, err));
        t.on('warning', () => { /* tracker noise */ });
        return t;
    }

    async _onMetadata(id, t) {
        if (this.handles.get(id) !== t) return;
        const files = fileList(t);
        const row0 = this.rows.get(id);
        if (!row0) return;
        let torrentFile = row0.torrentFile;
        if (!torrentFile && t.torrentFile) {
            torrentFile = t.infoHash + '.torrent';
            try { fs.writeFileSync(path.join(TORRENT_FILE_DIR, torrentFile), Buffer.from(t.torrentFile)); } catch { torrentFile = null; }
        }
        // keep the "done" flags of files finished before a restart
        const before = new Map(filesOf(row0).map(f => [f.index, f]));
        const first = !before.size;
        for (const f of files) {
            const prev = before.get(f.index);
            if (prev && prev.done) f.done = true;
            // Files already complete on disk before this torrent was added (an earlier
            // download): cancelling a preview must never delete them.
            if (prev ? prev.existed : first && fileComplete(f)) f.existed = true;
        }
        const data = {
            name: String(t.name || row0.name).slice(0, 500), files: JSON.stringify(files), totalSize: t.length, torrentFile,
            status: row0.status === 'metadata' ? 'pending' : row0.status
        };
        if (row0.kind === 'auto') data.kind = guessKind(t.name || row0.name, files);
        const row = await this._update(id, data);
        if (row.status === 'downloading') this._applySelection(row, t);
        // Restored download whose titles still have no artwork: grab a frame from the swarm.
        if (row.status === 'downloading' && row.autoImport && hasFfmpeg()) {
            for (const m of this.mediaByTorrent.get(id) || []) {
                if (m.fileIndex != null && !m.thumbnail) queueAnalysis(m.id, { input: torrentLoopbackUrl(id, m.fileIndex), trickplay: false });
            }
        }
        const auto = this.autoStart.get(id);
        if (auto && row.status === 'pending') {
            this.autoStart.delete(id);
            await this.start(id, auto);
        }
    }

    _applySelection(row, t) {
        if (!t.files || !t.files.length) return;
        const sel = safeJson(row.selected, []);
        // Clear background selections, then select chosen files. (Deselecting files
        // one by one would also drop pieces shared with neighbouring selected files.)
        if (t.pieces && t.pieces.length) t.deselect(0, t.pieces.length - 1);
        for (const i of sel) {
            const f = t.files[i];
            if (!f) continue;
            // Small companions (subtitles, poster.jpg) first: the player and the library need them early.
            const small = isSubtitleFile(f.name) || isArtworkFile(f.name, f.length);
            f.select(small ? 2 : 0);
            if (small && isArtworkFile(f.name, f.length) && !f.done && !f._mediaterArt) {
                f._mediaterArt = true;
                f.once('done', () => {
                    const r = this.rows.get(row.id);
                    if (r && r.autoImport) applyTorrentArtwork(r).catch(() => {});
                });
            }
        }
    }

    // ------------------------------------------------------------ actions
    async start(id, { files = null, kind = null, autoImport = true, match } = {}) {
        let row = this.rows.get(id);
        if (!row) throw new Error('Torrent not found');
        const t = this.handles.get(id) || this._attach(row);
        if (row.status === 'metadata') {
            this.autoStart.set(id, { files, kind, autoImport, match });
            return row;
        }
        const all = filesOf(row);
        const kindNow = ['movie', 'series', 'other'].includes(kind) ? kind : (row.kind === 'auto' ? guessKind(row.name, all) : row.kind);
        let selected = Array.isArray(files) && files.length ? files.map(Number).filter(i => all[i]) : defaultSelection(all, kindNow);
        // Program files are never downloaded, whatever was ticked.
        selected = selected.filter(i => !isExecutableFile(all[i].name));
        if (!selected.length) throw new Error('Nothing to download: this torrent only contains program files');
        // keep subtitle files that sit next to chosen videos
        for (const f of all) if (isSubtitleFile(f.name) && !selected.includes(f.index)) {
            const dir = path.dirname(f.path);
            if (selected.some(i => { const v = path.dirname(all[i].path); return dir === v || dir.startsWith(v + '/'); })) selected.push(f.index);
        }
        const data = {
            status: 'downloading', selected: JSON.stringify(selected), autoImport: !!autoImport, error: null,
            kind: kindNow
        };
        if (match !== undefined) data.match = match ? JSON.stringify(match) : null;
        row = await this._update(id, data);
        this._applySelection(row, t);
        if (row.autoImport && row.kind !== 'other') {
            try {
                const ids = await importTorrent(row);
                await applyTorrentArtwork(row);
                await this._refreshMediaLinks();
                // Grab a still frame straight from the swarm so the title has artwork right away.
                if (hasFfmpeg()) {
                    for (const mid of ids) {
                        const m = (this.mediaByTorrent.get(id) || []).find(x => x.id === mid);
                        if (m && m.fileIndex != null) queueAnalysis(mid, { input: torrentLoopbackUrl(id, m.fileIndex), trickplay: false });
                    }
                }
            } catch (e) { console.warn('[torrents] import failed:', e.message); }
        }
        this.emit('change', id);
        return row;
    }

    async pause(id) {
        const row = this.rows.get(id);
        if (!row) throw new Error('Torrent not found');
        if (row.status === 'completed') return row;
        // Mark it paused first, so nothing re-attaches it while it disconnects.
        const updated = await this._update(id, { status: 'paused' });
        await this._detach(id);
        return updated;
    }

    async resume(id) {
        let row = this.rows.get(id);
        if (!row) throw new Error('Torrent not found');
        if (this.closing.has(id)) throw new Error('This download is stopping, try again in a moment');
        if (row.status === 'completed') return row;
        const sel = safeJson(row.selected, []);
        const next = !sel.length ? (filesOf(row).length ? 'pending' : 'metadata') : 'downloading';
        row = await this._update(id, { status: next, error: null });
        this._attach(row);
        return row;
    }

    /**
     * Makes sure a torrent is connected before streaming from it. Paused downloads
     * only resume when someone presses play (`resume`), never for background jobs.
     */
    async ensureActive(id, { resume = false } = {}) {
        if (this.closing.has(id)) throw new Error('This download is stopping');
        const row = this.rows.get(id);
        if (!row) throw new Error('Torrent not found');
        if (this.handles.has(id)) return this.handles.get(id);
        if (row.status === 'paused' || row.status === 'error') {
            if (!resume) throw new Error('This download is paused');
            await this.resume(id);
        } else if (row.status === 'completed') {
            throw new Error('This download is finished and its file is missing');
        } else {
            this._attach(row);
        }
        return this.handles.get(id);
    }

    /** Absolute paths still used by the library or by other downloads (never deleted). */
    async _protectedPaths(id) {
        const keep = new Set();
        const media = await prisma.media.findMany({ where: { path: { startsWith: 'dl:' } }, select: { path: true, torrentId: true } });
        for (const m of media) if (m.torrentId !== id) keep.add(samePathKey(path.join(DOWNLOAD_DIR, m.path.slice(3))));
        const subs = await prisma.subtitle.findMany({ where: { path: { startsWith: 'dl:' } }, select: { path: true, media: { select: { torrentId: true } } } });
        for (const s of subs) if (!s.media || s.media.torrentId !== id) keep.add(samePathKey(path.join(DOWNLOAD_DIR, s.path.slice(3))));
        for (const r of this.rows.values()) if (r.id !== id) for (const f of filesOf(r)) keep.add(samePathKey(absPath(f)));
        return keep;
    }

    async remove(id, { deleteFiles = false } = {}) {
        const row = this.rows.get(id) || await prisma.torrent.findUnique({ where: { id } });
        if (!row) return;
        this.closing.add(id);
        try {
            // Gone from the list (and from every player) right away.
            this.rows.delete(id);
            this.autoStart.delete(id);
            const t = this.handles.get(id);
            const done = new Set(filesOf(row).filter(f => f.done || (t && t.files && t.files[f.index] && t.files[f.index].done)).map(f => f.index));
            await this._detach(id);
            const linked = await prisma.media.findMany({ where: { torrentId: id } });
            // Library entries whose file never finished can't play: drop them (all of them when deleting files).
            const drop = linked.filter(m => m.type !== 'series' && (deleteFiles || m.fileIndex == null || !done.has(m.fileIndex)));
            if (drop.length) await prisma.media.deleteMany({ where: { id: { in: drop.map(m => m.id) } } });
            for (const s of linked.filter(m => m.type === 'series')) {
                const left = await prisma.media.count({ where: { parentId: s.id } });
                if (!left) await prisma.media.delete({ where: { id: s.id } }).catch(() => {});
            }
            await prisma.media.updateMany({ where: { torrentId: id }, data: { torrentId: null, fileIndex: null } });
            if (deleteFiles) {
                const keep = await this._protectedPaths(id);
                // Only previewed, never started: keep what was already on disk before.
                const neverStarted = !safeJson(row.selected, []).length;
                for (const f of filesOf(row)) {
                    const p = absPath(f);
                    if (keep.has(samePathKey(p))) continue;
                    if (neverStarted && f.existed) continue;
                    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
                    // tidy empty folders up to DOWNLOAD_DIR
                    let dir = path.dirname(p);
                    while (dir.startsWith(DOWNLOAD_DIR + path.sep)) {
                        try { fs.rmdirSync(dir); } catch { break; }
                        dir = path.dirname(dir);
                    }
                }
            }
            if (row.torrentFile) {
                try { fs.rmSync(path.join(TORRENT_FILE_DIR, row.torrentFile), { force: true }); } catch { /* ignore */ }
            }
            await prisma.torrent.delete({ where: { id } }).catch(() => {});
            await this._refreshMediaLinks();
            this.emit('change', id);
        } finally {
            this.closing.delete(id);
        }
    }

    /** Re-runs the library import for a torrent (e.g. after changing the match). */
    async reimport(id, { match, kind } = {}) {
        const data = {};
        if (match !== undefined) data.match = match ? JSON.stringify(match) : null;
        if (kind) data.kind = kind;
        const row = Object.keys(data).length ? await this._update(id, data) : this.rows.get(id);
        const ids = await importTorrent(row);
        await this._refreshMediaLinks();
        if (row.status === 'completed') ids.forEach(mid => queueAnalysis(mid));
        this.emit('change', id);
        return ids;
    }

    async _detach(id) {
        const t = this.handles.get(id);
        if (!t) return;
        const mine = !this.closing.has(id);
        this.closing.add(id);
        this.handles.delete(id);
        try {
            await this._persist(id, t).catch(() => {});
            await new Promise(resolve => {
                try { this.client.remove(t, { destroyStore: false }, () => resolve()); } catch { resolve(); }
                setTimeout(resolve, 5000);
            });
        } finally {
            if (mine) this.closing.delete(id);
        }
    }

    async _fail(id, err) {
        const msg = (err && err.message) || String(err);
        console.warn(`[torrents] #${id}: ${msg}`);
        const t = this.handles.get(id);
        if (t) {
            this.handles.delete(id);
            try { t.destroy({ destroyStore: false }); } catch { /* already gone */ }
        }
        if (this.rows.has(id)) await this._update(id, { status: 'error', error: msg.slice(0, 500) }).catch(() => {});
    }

    async _update(id, data) {
        const row = await prisma.torrent.update({ where: { id }, data });
        if (this.rows.has(id)) this.rows.set(id, row);
        this.emit('change', id);
        return row;
    }

    /** Drops a finished movie/show from the list. Its titles keep playing from the files on disk. */
    async _forget(id) {
        const row = this.rows.get(id);
        if (!row) return;
        this.retired.set(id, { id, infoHash: row.infoHash, name: row.name, files: row.files, status: 'completed' });
        if (this.retired.size > 100) this.retired.delete(this.retired.keys().next().value);
        this.rows.delete(id);
        this.autoStart.delete(id);
        await prisma.media.updateMany({ where: { torrentId: id }, data: { torrentId: null, fileIndex: null } });
        if (row.torrentFile) {
            try { fs.rmSync(path.join(TORRENT_FILE_DIR, row.torrentFile), { force: true }); } catch { /* ignore */ }
        }
        await prisma.torrent.delete({ where: { id } }).catch(() => {});
        await this._refreshMediaLinks();
        this.emit('change', id);
    }

    // ------------------------------------------------------------ stats
    _selectedStats(row, t) {
        const sel = safeJson(row.selected, []);
        if (!t || !t.files || !t.files.length) {
            return { size: row.totalSize || 0, downloaded: row.downloaded || 0, done: row.progress >= 1, files: null };
        }
        let size = 0, downloaded = 0, done = sel.length > 0;
        for (const i of sel) {
            const f = t.files[i];
            if (!f) continue;
            size += f.length;
            downloaded += Math.min(f.length, f.downloaded);
            if (!f.done) done = false;
        }
        return { size, downloaded, done };
    }

    async _tick() {
        if (this.ticking) return;
        this.ticking = true;
        try {
            this.ticks++;
            for (const [id, t] of [...this.handles]) {
                const row = this.rows.get(id);
                if (!row || !t.files || !t.files.length) continue;
                if (row.status === 'downloading' && this._selectedStats(row, t).done) {
                    this._finish(id, t).catch(e => console.warn(`[torrents] #${id} finishing:`, e.message));
                }
            }
            if (this.ticks % 15 === 0) { await this._persistAll(); await this._refreshMediaLinks().catch(() => {}); }
            if (this.listenerCount('stats')) this.emit('stats', this.snapshot());
        } finally {
            this.ticking = false;
        }
    }

    /** Download complete: disconnect (no seeding), add to the library and leave the list. */
    async _finish(id, t) {
        if (this.finishing.has(id)) return;
        const row0 = this.rows.get(id);
        if (!row0) return;
        this.finishing.add(id);
        try {
            const st = this._selectedStats(row0, t);
            const files = filesOf(row0).map(f => {
                const wf = t && t.files && t.files[f.index];
                return wf && wf.done ? { ...f, done: true } : f;
            });
            await this._update(id, { status: 'completed', progress: 1, downloaded: st.size, completedAt: new Date(), files: JSON.stringify(files) });
            await this._detach(id);
            console.log(`[torrents] finished: ${row0.name}`);
            const row = this.rows.get(id);
            if (!row) return; // removed meanwhile
            let ids = [];
            if (row.autoImport && row.kind !== 'other') {
                try {
                    ids = await importTorrent(row);
                    await applyTorrentArtwork(row);
                } catch (e) {
                    console.warn('[torrents] import on completion failed:', e.message);
                    await this._update(id, { error: `Could not add it to the library: ${e.message}`.slice(0, 500) }).catch(() => {});
                }
            }
            const linked = await prisma.media.findMany({ where: { torrentId: id }, select: { id: true, title: true, type: true, parentId: true, created_at: true } });
            // Everyone can watch it from now on, so "New" rows and notifications count from today.
            const added = linked.filter(m => new Date(m.created_at) >= new Date(row.addedAt)).map(m => m.id);
            if (added.length) await prisma.media.updateMany({ where: { id: { in: added } }, data: { created_at: new Date() } });
            for (const mid of ids) queueAnalysis(mid);
            await this._remember(row, linked);
            this.emit('complete', row);
            if (ids.length) await this._forget(id);
            else await this._refreshMediaLinks();
        } finally {
            this.finishing.delete(id);
        }
    }

    async _remember(row, linked) {
        let title = row.name, href = null;
        const top = linked.find(m => m.type === 'movie' || m.type === 'series');
        const ep = linked.find(m => m.type === 'episode');
        if (top) { title = top.title; href = '/title/' + top.id; }
        else if (ep && ep.parentId) {
            const s = await prisma.media.findUnique({ where: { id: ep.parentId }, select: { id: true, title: true } }).catch(() => null);
            if (s) { title = s.title; href = '/title/' + s.id; }
        }
        this.recent.unshift({ key: `${row.id}-${Date.now()}`, name: row.name, title, href, kind: row.kind, at: Date.now() });
        this.recent = this.recent.slice(0, 20);
    }

    async _persist(id, t) {
        const row = this.rows.get(id);
        if (!row || !t || !t.files || !t.files.length) return;
        const st = this._selectedStats(row, t);
        const progress = st.size ? st.downloaded / st.size : 0;
        // Remember which files are complete, so they keep playing from disk while paused.
        const files = filesOf(row);
        let filesChanged = false;
        const next = files.map(f => {
            const wf = t.files[f.index];
            if (!wf) return f;
            if (wf.done && !f.done) { filesChanged = true; return { ...f, done: true }; }
            if (!wf.done && f.done && t.ready) { filesChanged = true; return { ...f, done: false }; }
            return f;
        });
        if (!filesChanged && Math.abs(progress - row.progress) < 0.0005) return;
        const data = { progress, downloaded: st.downloaded };
        if (filesChanged) data.files = JSON.stringify(next);
        const fresh = await prisma.torrent.update({ where: { id }, data });
        if (this.rows.has(id)) this.rows.set(id, fresh);
    }

    async _persistAll() {
        for (const [id, t] of this.handles) await this._persist(id, t).catch(() => {});
    }

    async _refreshMediaLinks() {
        const media = await prisma.media.findMany({ where: { torrentId: { not: null } }, select: { id: true, title: true, type: true, torrentId: true, fileIndex: true, parentId: true, poster: true, thumbnail: true } });
        const map = new Map();
        for (const m of media) {
            if (!map.has(m.torrentId)) map.set(m.torrentId, []);
            map.get(m.torrentId).push(m);
        }
        this.mediaByTorrent = map;
    }

    /** media id -> download progress (0..1) for titles whose files are not complete yet. */
    downloadingMedia() {
        const out = new Map();
        for (const [tid, items] of this.mediaByTorrent) {
            const row = this.rows.get(tid);
            if (!row || row.status === 'completed') continue;
            const t = this.handles.get(tid);
            const files = filesOf(row);
            for (const m of items) {
                if (m.fileIndex == null) continue;
                const f = t && t.files && t.files[m.fileIndex];
                const meta = files[m.fileIndex];
                const p = f ? f.progress : (meta && meta.done ? 1 : Math.min(0.999, row.progress || 0));
                if (p < 1) out.set(m.id, p);
            }
        }
        return out;
    }

    _piecesBar(t, row, buckets = 120) {
        if (!t || !t.bitfield || !t.pieces || !t.pieces.length) return '';
        const sel = safeJson(row.selected, []);
        const ranges = sel.map(i => t.files[i]).filter(Boolean).map(f => [f._startPiece, f._endPiece]);
        if (!ranges.length) return '';
        const pieces = [];
        for (const [a, b] of ranges) for (let i = a; i <= b; i++) pieces.push(i);
        const uniq = [...new Set(pieces)].sort((a, b) => a - b);
        const n = Math.min(buckets, uniq.length);
        let out = '';
        for (let b = 0; b < n; b++) {
            const from = Math.floor(b * uniq.length / n), to = Math.floor((b + 1) * uniq.length / n);
            let have = 0;
            for (let k = from; k < to; k++) if (t.bitfield.get(uniq[k])) have++;
            out += Math.round((have / Math.max(1, to - from)) * 9);
        }
        return out;
    }

    describe(id, { withFiles = true } = {}) {
        const row = this.rows.get(id);
        if (!row) return null;
        const t = this.handles.get(id);
        const live = !!(t && t.files && t.files.length);
        const st = this._selectedStats(row, t);
        const files = filesOf(row);
        const sel = new Set(safeJson(row.selected, []));
        const progress = row.status === 'completed' ? 1 : (st.size ? st.downloaded / st.size : row.progress);
        const downSpeed = live && row.status === 'downloading' ? t.downloadSpeed : 0;
        const remaining = Math.max(0, st.size - st.downloaded);
        const out = {
            id: row.id, infoHash: row.infoHash, name: row.name, status: row.status, error: row.error,
            kind: row.kind, autoImport: row.autoImport, addedAt: row.addedAt, completedAt: row.completedAt,
            totalSize: row.totalSize, size: st.size, downloaded: st.downloaded, progress,
            downloadSpeed: downSpeed,
            peers: t ? t.numPeers : 0,
            eta: downSpeed > 1024 && remaining ? Math.round(remaining / downSpeed) : null,
            match: safeJson(row.match, null),
            media: (this.mediaByTorrent.get(id) || []).map(m => ({ id: m.id, title: m.title, type: m.type, fileIndex: m.fileIndex, parentId: m.parentId })),
            pieces: live ? this._piecesBar(t, row) : '',
            art: (() => {
                const items = this.mediaByTorrent.get(id) || [];
                const top = items.find(m => m.type === 'movie' || m.type === 'series') || items[0];
                return top ? (top.poster || top.thumbnail || null) : null;
            })(),
            mainFile: (() => {
                const vids = files.filter(f => isVideoFile(f.name) && !isSampleFile(f.name, f.length));
                const pool = vids.filter(f => sel.has(f.index));
                const list = pool.length ? pool : vids;
                return list.length ? list.reduce((a, b) => (b.length > a.length ? b : a)).index : null;
            })()
        };
        if (withFiles) {
            out.files = files.map(f => ({
                index: f.index, name: f.name, path: f.path, length: f.length, selected: sel.has(f.index),
                progress: live && t.files[f.index] ? t.files[f.index].progress : (f.done ? 1 : sel.has(f.index) ? progress : 0),
                video: isVideoFile(f.name), subtitle: isSubtitleFile(f.name), sample: isSampleFile(f.name, f.length),
                program: isExecutableFile(f.name)
            }));
        }
        return out;
    }

    snapshot() {
        return [...this.rows.keys()].sort((a, b) => b - a).map(id => this.describe(id, { withFiles: false }));
    }

    summary() {
        let active = 0, down = 0;
        for (const row of this.rows.values()) if (row.status === 'downloading' || row.status === 'metadata') active++;
        for (const t of this.handles.values()) down += t.downloadSpeed || 0;
        return { enabled: this.enabled, active, total: this.rows.size, downloadSpeed: down, reason: this.disabledReason };
    }

    // ------------------------------------------------------------ streaming
    /** Info about one file of a torrent: whether it can be streamed live and where it lives on disk. */
    fileInfo(id, fileIndex) {
        const row = this.rows.get(id);
        if (!row) {
            // finished and dropped from the list: the file is on disk
            const r = this.retired.get(id);
            const f = r && filesOf(r)[fileIndex];
            if (!f) return null;
            const abs = absPath(f);
            const complete = fs.existsSync(abs);
            return { row: r, file: f, abs, live: false, complete, progress: complete ? 1 : 0, length: f.length, name: f.name };
        }
        const f = filesOf(row)[fileIndex];
        if (!f) return null;
        const t = this.handles.get(id);
        const wf = t && t.files && t.files[fileIndex];
        const abs = absPath(f);
        const complete = wf ? wf.done : (row.status === 'completed' || f.done) && fs.existsSync(abs);
        const progress = wf ? wf.progress : (complete ? 1 : row.progress || 0);
        return { row, file: f, abs, live: !!wf, complete: !!complete, progress, length: f.length, name: f.name };
    }

    /** Readable stream of a byte range of a torrent file (pieces are fetched on demand). */
    async createStream(id, fileIndex, start, end, { resume = false } = {}) {
        const t = await this.ensureActive(id, { resume });
        if (!t.files || !t.files.length) await new Promise((resolve, reject) => {
            const to = setTimeout(() => reject(new Error('Timed out waiting for torrent metadata')), 60000);
            t.once('metadata', () => { clearTimeout(to); resolve(); });
        });
        const f = t.files[fileIndex];
        if (!f) throw new Error('File not found in torrent');
        return limitBytes(f.createReadStream({ start, end: Math.max(end, start + 1) }), end - start + 1);
    }
}

const engine = new TorrentEngine();
export default engine;
