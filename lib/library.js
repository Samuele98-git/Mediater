// Catalog logic: what each profile sees, Netflix-style rows, recommendations,
// search, background analysis of video files, and importing torrents.
import fs from 'fs';
import path from 'path';
import prisma from './prisma.js';
import { UPLOAD_DIR, CACHE_DIR, DOWNLOAD_DIR } from './config.js';
import { resolveMediaPath, fileExists } from './media-paths.js';
import { hasFfmpeg, hasFfprobe, probe, qualityLabel, extractFrame, generateTrickplay } from './ffmpeg.js';
import { enqueue } from './jobs.js';
import { getSettings } from './settings.js';
import { loadLocale, makeT, pickLang, SUPPORTED } from './i18n.js';
import * as tmdb from './tmdb.js';
import { parseRelease, detectEpisodes, isVideoFile, isSubtitleFile, isSampleFile, isArtworkFile } from './release-name.js';
import { guessSubtitleInfo, languageName } from './subtitles.js';

const DAY = 86_400_000;

export const splitGenres = (g) => String(g || '').split(',').map(s => s.trim()).filter(Boolean);
export const normText = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const safeJson = (s, fallback = null) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

export function youtubeId(url) {
    const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
}

// ---------------------------------------------------------------- kids
const KIDS_RATINGS = new Set(['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG', 'U', 'T', 'ALL', 'E', 'AL', 'TP', 'GENEL İZLEYİCİ KİTLESİ']);
const KIDS_GENRES = /(^|,)\s*(animation|animazione|animación|animasyon|family|famiglia|familia|famille|familial|aile|kids|bambini|niños|enfants|çocuk)\s*(,|$)/i;

export function isKidSafe(m) {
    const r = String(m.maturity || '').trim().toUpperCase();
    if (r) {
        if (KIDS_RATINGS.has(r)) return true;
        const n = r.match(/^(?:VM)?(\d{1,2})\+?$/);
        return n ? parseInt(n[1], 10) <= 10 : false;
    }
    return KIDS_GENRES.test(m.genres || '');
}

// ---------------------------------------------------------------- loading
const EP_SELECT = {
    id: true, parentId: true, season: true, order: true, title: true, description: true, duration: true,
    thumbnail: true, path: true, probe: true, torrentId: true, introStart: true, introEnd: true, creditsStart: true,
    created_at: true
};

/**
 * Everything a profile can see. `hide` holds ids of movies/episodes that must not
 * show up (files still downloading, for everyone but the admin): a show whose
 * episodes are all hidden is hidden too.
 */
export async function loadLibrary(profile, { hide = null } = {}) {
    let [titles, episodes] = await Promise.all([
        prisma.media.findMany({ where: { type: { in: ['movie', 'series'] } }, orderBy: { id: 'desc' } }),
        prisma.media.findMany({ where: { type: 'episode' }, select: EP_SELECT })
    ]);
    if (hide && hide.size) {
        const withEpisodes = new Set(episodes.map(e => e.parentId));
        episodes = episodes.filter(e => !hide.has(e.id));
        const stillHas = new Set(episodes.map(e => e.parentId));
        titles = titles.filter(m => !hide.has(m.id) && !(m.type === 'series' && withEpisodes.has(m.id) && !stillHas.has(m.id)));
    }
    episodes.sort((a, b) => (a.season || 1) - (b.season || 1) || a.order - b.order || a.id - b.id);
    const visible = profile && profile.isKids ? titles.filter(isKidSafe) : titles;
    const epBySeries = new Map();
    for (const e of episodes) {
        if (!epBySeries.has(e.parentId)) epBySeries.set(e.parentId, []);
        epBySeries.get(e.parentId).push(e);
    }
    return {
        titles: visible,
        visibleIds: new Set(visible.map(t => t.id)),
        byId: new Map(titles.map(t => [t.id, t])),
        epById: new Map(episodes.map(e => [e.id, e])),
        epBySeries
    };
}

export async function loadProfileState(profileId) {
    const [progress, list, ratings] = await Promise.all([
        prisma.watchProgress.findMany({ where: { userId: profileId }, orderBy: { updatedAt: 'desc' } }),
        prisma.myListItem.findMany({ where: { userId: profileId }, orderBy: { addedAt: 'desc' } }),
        prisma.rating.findMany({ where: { userId: profileId } })
    ]);
    return {
        progress,
        progressBy: new Map(progress.map(p => [p.mediaId, p])),
        listIds: new Set(list.map(l => l.mediaId)),
        listOrder: list.map(l => l.mediaId),
        ratingBy: new Map(ratings.map(r => [r.mediaId, r.value]))
    };
}

// ---------------------------------------------------------------- scoring
export function buildAffinity(lib, state) {
    const aff = new Map();
    const add = (m, w) => { if (m) for (const g of splitGenres(m.genres)) aff.set(g, (aff.get(g) || 0) + w); };
    for (const p of state.progress) {
        const ep = lib.epById.get(p.mediaId);
        const m = ep ? lib.byId.get(ep.parentId) : lib.byId.get(p.mediaId);
        add(m, p.duration > 0 && p.position / p.duration > 0.5 ? 1 : 0.5);
    }
    for (const [mid, v] of state.ratingBy) add(lib.byId.get(mid), v === 2 ? 3 : v === 1 ? 2 : -3);
    return aff;
}

export function matchScore(m, aff) {
    let score = m.rating ? 60 + m.rating * 3.5 : 82;
    if (aff && aff.size) {
        const gs = splitGenres(m.genres);
        if (gs.length) {
            const max = Math.max(1, ...[...aff.values()].map(Math.abs));
            const s = gs.reduce((a, g) => a + (aff.get(g) || 0), 0) / gs.length;
            score += Math.max(-1, Math.min(1, s / max)) * 12;
        }
    }
    return Math.max(50, Math.min(99, Math.round(score)));
}

export const isFinished = (p, media) => {
    if (!p || !(p.duration > 0)) return false;
    if (media && media.creditsStart && p.position >= media.creditsStart) return true;
    return p.position / p.duration >= 0.9 || p.duration - p.position < 60;
};

// ---------------------------------------------------------------- previews
function universalVideo(target) {
    const info = safeJson(target.probe);
    if (info && info.video) return info.video.codec === 'h264' && (info.video.bits || 8) <= 8;
    return /\.(mp4|m4v|mkv|webm|mov)$/i.test(target.path || '');
}

/** What the hover card / billboard can play muted: a trailer or the title's own footage. */
export function previewSource(m, lib, downloading) {
    if (m.trailerUrl && !youtubeId(m.trailerUrl) && !/^https?:/i.test(m.trailerUrl)) {
        return { kind: 'video', src: `/stream/trailer/${m.id}`, start: 0 };
    }
    const target = m.type === 'series' ? (lib.epBySeries.get(m.id) || []).find(e => e.path) : m;
    if (target && target.path && !/^https?:/i.test(target.path) && !(downloading && downloading.has(target.id)) && universalVideo(target)) {
        const info = safeJson(target.probe);
        const dur = (info && info.duration) || (target.duration ? target.duration * 60 : 0);
        const start = dur ? Math.min(Math.round(dur * (m.type === 'series' ? 0.12 : 0.18)), 900) : 120;
        return { kind: 'video', src: `/stream/m/${target.id}`, start };
    }
    const yt = youtubeId(m.trailerUrl);
    return yt ? { kind: 'youtube', id: yt } : null;
}

/** Compact data the browse UI needs for cards, hover previews and the billboard. */
export function titleCard(m, lib, state, aff, downloading) {
    const eps = m.type === 'series' ? (lib.epBySeries.get(m.id) || []) : [];
    const seasons = new Set(eps.map(e => e.season || 1));
    const dl = downloading ? (m.type === 'series' ? eps.map(e => downloading.get(e.id)).find(v => v != null) : downloading.get(m.id)) : null;
    return {
        id: m.id,
        type: m.type,
        title: m.title,
        year: m.releaseYear || null,
        maturity: m.maturity || '',
        quality: m.quality || '',
        genres: splitGenres(m.genres).slice(0, 3),
        duration: m.type === 'movie' ? (m.duration || null) : null,
        seasons: m.type === 'series' ? seasons.size : null,
        episodes: m.type === 'series' ? eps.length : null,
        match: matchScore(m, aff),
        isNew: Date.now() - new Date(m.created_at).getTime() < 14 * DAY,
        img: m.thumbnail || m.backdrop || m.poster || '',
        backdrop: m.backdrop || m.thumbnail || '',
        poster: m.poster || '',
        logo: m.logoUrl || '',
        synopsis: String(m.description || '').slice(0, 320),
        inList: state.listIds.has(m.id),
        thumb: state.ratingBy.get(m.id) || 0,
        score: m.rating || null,
        preview: previewSource(m, lib, downloading),
        downloading: dl != null ? Math.round(dl * 100) : null
    };
}

// ---------------------------------------------------------------- rows
export function continueWatching(lib, state, limit = 20) {
    const out = [];
    const seenSeries = new Set();
    for (const p of state.progress) {
        const ep = lib.epById.get(p.mediaId);
        if (ep) {
            if (seenSeries.has(ep.parentId) || !lib.visibleIds.has(ep.parentId)) continue;
            seenSeries.add(ep.parentId);
            const eps = lib.epBySeries.get(ep.parentId) || [];
            let target = ep, prog = p;
            if (isFinished(p, ep)) {
                const next = eps[eps.findIndex(e => e.id === ep.id) + 1];
                if (!next) continue;
                target = next;
                prog = state.progressBy.get(next.id) || null;
            }
            out.push({
                title: lib.byId.get(ep.parentId), episode: target, playId: target.id,
                pct: prog && prog.duration > 0 ? Math.min(1, prog.position / prog.duration) : 0
            });
        } else {
            const m = lib.byId.get(p.mediaId);
            if (!m || m.type !== 'movie' || !lib.visibleIds.has(m.id)) continue;
            if (isFinished(p, m) || p.position < 15) continue;
            out.push({ title: m, playId: m.id, pct: p.duration > 0 ? p.position / p.duration : 0 });
        }
        if (out.length >= limit) break;
    }
    return out;
}

export async function topTen(lib, type) {
    const since = new Date(Date.now() - 30 * DAY);
    const recent = await prisma.watchProgress.findMany({ where: { updatedAt: { gte: since } }, select: { userId: true, mediaId: true } });
    const viewers = new Map();
    for (const r of recent) {
        const ep = lib.epById.get(r.mediaId);
        const id = ep ? ep.parentId : r.mediaId;
        if (!viewers.has(id)) viewers.set(id, new Set());
        viewers.get(id).add(r.userId);
    }
    const now = Date.now();
    return lib.titles
        .filter(t => !type || t.type === type)
        .map(t => ({
            t,
            score: (viewers.get(t.id)?.size || 0) * 10 + (t.trending ? 6 : 0) + (t.rating || 6) / 2 +
                Math.max(0, 3 - (now - new Date(t.created_at).getTime()) / (10 * DAY))
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(x => x.t);
}

export function similarTitles(target, lib, n = 12) {
    const tg = new Set(splitGenres(target.genres).map(normText));
    return lib.titles
        .filter(m => m.id !== target.id)
        .map(m => {
            const g = new Set(splitGenres(m.genres).map(normText));
            const inter = [...g].filter(x => tg.has(x)).length;
            const union = new Set([...g, ...tg]).size || 1;
            const score = (inter / union) * 3 + (m.category === target.category ? 0.6 : 0) +
                (m.type === target.type ? 0.3 : 0) + (m.rating || 0) / 25;
            return { m, score, inter };
        })
        .filter(x => x.inter > 0 || x.score >= 0.6)
        .sort((a, b) => b.score - a.score)
        .slice(0, n)
        .map(x => x.m);
}

export function hasGenre(m, genre) {
    const g = normText(genre);
    return splitGenres(m.genres).some(x => normText(x) === g) || normText(m.category) === g;
}

export function allGenres(titles) {
    const counts = new Map();
    for (const m of titles) for (const g of splitGenres(m.genres)) counts.set(g, (counts.get(g) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g, c]) => ({ name: g, count: c }));
}

export function pickBillboard(pool) {
    const withArt = pool.filter(m => m.backdrop || m.thumbnail);
    if (!withArt.length) return null;
    const score = (m) => (m.backdrop ? 2 : 0) + (m.logoUrl ? 2 : 0) + (m.trending ? 3 : 0) + (m.description ? 1 : 0) + (m.rating || 0) / 5;
    const ranked = [...withArt].sort((a, b) => score(b) - score(a)).slice(0, 6);
    return ranked[Math.floor(Math.random() * ranked.length)];
}

/**
 * Builds the rows of a browse page.
 * Each row: { key, title, kind: 'standard'|'continue'|'top10'|'tall', items: [{ id, playId?, pct?, episode? }], link? }
 */
export async function buildRows(lib, state, { type = null, genre = null, t, profileName, appName }) {
    const pool = lib.titles.filter(m => (!type || m.type === type) && (!genre || hasGenre(m, genre)));
    const rows = [];
    const used = new Set();
    const push = (row) => { if (row.items.length) rows.push(row); };
    const ids = (arr) => arr.map(m => ({ id: m.id }));

    const cw = continueWatching(lib, state).filter(x => pool.some(p => p.id === x.title.id));
    push({
        key: 'continue', kind: 'continue', title: t('rows.continue_watching', { name: profileName }),
        items: cw.map(x => ({ id: x.title.id, playId: x.playId, pct: x.pct, episode: x.episode ? { season: x.episode.season || 1, order: x.episode.order, title: x.episode.title } : null }))
    });

    if (!genre) {
        const types = type ? [type] : ['movie', 'series'];
        for (const ty of types) {
            if (pool.filter(m => m.type === ty).length < 4) continue;
            const top = await topTen(lib, ty);
            push({ key: 'top-' + ty, kind: 'top10', title: t(ty === 'movie' ? 'rows.top10_movies' : 'rows.top10_shows', { app: appName }), items: ids(top) });
        }
    }

    const listItems = state.listOrder.map(id => lib.byId.get(id)).filter(m => m && pool.includes(m));
    push({ key: 'mylist', kind: 'standard', title: t('nav.my_list'), items: ids(listItems), link: '/browse/my-list' });

    const trending = pool.filter(m => m.trending);
    push({ key: 'trending', kind: 'standard', title: t('rows.trending_now'), items: ids(trending) });
    trending.forEach(m => used.add(m.id));

    const fresh = pool.filter(m => Date.now() - new Date(m.created_at).getTime() < 30 * DAY).slice(0, 20);
    if (fresh.length >= 2) push({ key: 'new', kind: 'standard', title: t('rows.new_on', { app: appName }), items: ids(fresh), link: '/latest' });

    // "Because you watched X"
    const lastWatched = state.progress.map(p => {
        const ep = lib.epById.get(p.mediaId);
        return ep ? lib.byId.get(ep.parentId) : lib.byId.get(p.mediaId);
    }).find(m => m && pool.includes(m));
    if (lastWatched) {
        const sim = similarTitles(lastWatched, lib, 15).filter(m => pool.includes(m));
        if (sim.length >= 2) push({ key: 'because', kind: 'standard', title: t('rows.because_you_watched', { title: lastWatched.title }), items: ids(sim) });
    }

    // Admin-defined categories, then genres
    const catNames = new Map();
    for (const m of pool) {
        const c = (m.category || '').trim();
        if (!c || c === 'Episode' || isGenericCategory(c)) continue;
        if (!catNames.has(c)) catNames.set(c, []);
        catNames.get(c).push(m);
    }
    const shownNames = new Set();
    let tallUsed = false;
    for (const [name, items] of catNames) {
        shownNames.add(normText(name));
        const kind = !tallUsed && items.length >= 4 && items.filter(m => m.poster).length >= items.length * 0.6 ? 'tall' : 'standard';
        if (kind === 'tall') tallUsed = true;
        push({ key: 'cat-' + name, kind, title: name, items: ids(items), link: '/browse/genre/' + encodeURIComponent(name) });
    }
    if (!genre) {
        for (const g of allGenres(pool).filter(g => g.count >= 3 && !shownNames.has(normText(g.name))).slice(0, 8)) {
            push({ key: 'genre-' + g.name, kind: 'standard', title: g.name, items: ids(pool.filter(m => hasGenre(m, g.name))), link: '/browse/genre/' + encodeURIComponent(g.name) });
        }
    }

    const acclaimed = pool.filter(m => (m.rating || 0) >= 7.5).sort((a, b) => b.rating - a.rating);
    if (acclaimed.length >= 4) push({ key: 'acclaimed', kind: 'standard', title: t('rows.critically_acclaimed'), items: ids(acclaimed) });

    const watchAgain = [];
    for (const p of state.progress) {
        const m = lib.byId.get(p.mediaId);
        if (m && m.type === 'movie' && pool.includes(m) && isFinished(p, m)) watchAgain.push(m);
    }
    push({ key: 'again', kind: 'standard', title: t('rows.watch_again'), items: ids(watchAgain) });

    // Anything not shown yet gets an "All titles" row so nothing is unreachable.
    const shown = new Set(rows.flatMap(r => r.items.map(i => i.id)));
    const rest = pool.filter(m => !shown.has(m.id));
    if (rest.length) push({ key: 'more', kind: 'standard', title: t(type === 'series' ? 'rows.more_shows' : type === 'movie' ? 'rows.more_movies' : 'rows.more_to_explore'), items: ids(rest) });
    return rows;
}

export function searchTitles(lib, q, limit = 60) {
    const nq = normText(q);
    if (!nq) return [];
    const scored = [];
    for (const m of lib.titles) {
        const title = normText(m.title);
        let s = 0;
        if (title === nq) s = 120;
        else if (title.startsWith(nq)) s = 100;
        else if (title.includes(nq)) s = 80;
        else if (normText(m.cast).includes(nq) || normText(m.director).includes(nq)) s = 55;
        else if (normText(m.genres).includes(nq) || normText(m.category).includes(nq)) s = 45;
        else if (normText(m.description).includes(nq)) s = 25;
        if (!s && m.type === 'series') {
            const eps = lib.epBySeries.get(m.id) || [];
            if (eps.some(e => normText(e.title).includes(nq))) s = 30;
        }
        if (s) scored.push({ m, s: s + (m.rating || 0) / 10 });
    }
    return scored.sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.m);
}

// ---------------------------------------------------------------- analysis
export function queueAnalysis(mediaId, opts = {}) {
    // A quick pass over the swarm (still downloading) must not swallow the full
    // analysis queued when the file is complete, so they use different keys.
    return enqueue(`analyze:${mediaId}${opts.input ? ':stream' : ''}`, () => analyzeMedia(mediaId, opts));
}

export function trickplayDir(mediaId) {
    return path.join(CACHE_DIR, 'trickplay', String(mediaId));
}

export function clearDerived(mediaId) {
    try { fs.rmSync(trickplayDir(mediaId), { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Probes a title's file and fills duration/quality, a still frame when there is no artwork, and scrub thumbnails. */
export async function analyzeMedia(mediaId, { trickplay = true, force = false, input = null } = {}) {
    const m = await prisma.media.findUnique({ where: { id: mediaId } });
    if (!m || !m.path) return;
    // `input` is a loopback URL while the file is still downloading over BitTorrent
    // (once the download is finished the title is no longer linked: use the file).
    if (input && m.torrentId == null) input = null;
    let src = input;
    if (!src) {
        const loc = resolveMediaPath(m.path);
        if (!loc || loc.kind !== 'file' || !fs.existsSync(loc.file)) return;
        src = loc.file;
    }
    const data = {};
    let info = safeJson(m.probe);
    if (hasFfprobe() && (!info || force)) {
        info = await probe(src, { timeoutMs: input ? 120000 : 60000 });
        data.probe = JSON.stringify(info);
    }
    if (info) {
        if (!m.duration && info.duration) data.duration = Math.max(1, Math.round(info.duration / 60));
        const q = qualityLabel(info);
        if (q && !m.quality) data.quality = q;
    }
    if (hasFfmpeg() && info && info.video && !m.thumbnail) {
        const at = Math.round((info.duration || 600) * (m.type === 'episode' ? 0.2 : 0.15));
        const rel = `images/auto-${m.id}-${Date.now().toString(36)}.jpg`;
        try {
            await extractFrame(src, path.join(UPLOAD_DIR, rel), { at, width: 1280 });
            data.thumbnail = '/uploads/' + rel;
            if (m.type === 'movie' && !m.backdrop) data.backdrop = data.thumbnail;
        } catch (e) { console.warn(`[analyze] frame for #${m.id}: ${e.message}`); }
    }
    if (Object.keys(data).length) await prisma.media.update({ where: { id: m.id }, data });

    if (m.type === 'episode' && m.parentId && data.thumbnail) {
        const s = await prisma.media.findUnique({ where: { id: m.parentId } });
        if (s && !s.thumbnail && !s.backdrop) {
            await prisma.media.update({ where: { id: s.id }, data: { thumbnail: data.thumbnail, backdrop: data.thumbnail } });
        }
    }

    const settings = await getSettings();
    if (trickplay && !input && hasFfmpeg() && info && info.video && settings.TRICKPLAY !== 'false') {
        const dir = trickplayDir(m.id);
        if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
            const interval = info.duration > 7200 ? 15 : 10;
            enqueue('trickplay:' + m.id, () => generateTrickplay(src, dir, { duration: info.duration, interval }));
        }
    }
}

// ---------------------------------------------------------------- TMDB
/** "General", or the placeholder "Movies"/"TV Shows" row name in any UI language. */
export function isGenericCategory(c) {
    const v = normText(c);
    if (!v || v === 'general') return true;
    return SUPPORTED.some(code => {
        const nav = loadLocale(code).nav || {};
        return v === normText(nav.movies) || v === normText(nav.tv_shows);
    });
}

function metaFields(meta, parsed, type, t) {
    const genres = meta ? meta.genres : '';
    const fallbackCat = t(type === 'series' ? 'nav.tv_shows' : 'nav.movies');
    return {
        title: (meta && meta.title) || parsed.title || 'Untitled',
        description: (meta && meta.description) || '',
        tagline: (meta && meta.tagline) || null,
        genres: genres || '',
        category: splitGenres(genres)[0] || fallbackCat,
        releaseYear: (meta && meta.releaseYear) || parsed.year || null,
        duration: type === 'movie' && meta ? meta.duration : null,
        maturity: (meta && meta.maturity) || null,
        rating: (meta && meta.rating) || null,
        poster: (meta && meta.poster) || null,
        backdrop: (meta && meta.backdrop) || null,
        thumbnail: (meta && meta.thumbnail) || null,
        logoUrl: (meta && meta.logoUrl) || null,
        trailerUrl: (meta && meta.trailerUrl) || null,
        cast: (meta && meta.cast) || null,
        director: (meta && meta.director) || null,
        tmdbId: (meta && meta.tmdbId) || null,
        imdbId: (meta && meta.imdbId) || null,
        quality: parsed.quality === '4K' ? '4K' : parsed.quality ? 'HD' : null
    };
}

/** Applies TMDB details to an existing title (and its episodes for series). */
export async function applyTmdb(mediaId, tmdbType, tmdbId) {
    const meta = await tmdb.details(tmdbType, tmdbId);
    const m = await prisma.media.findUnique({ where: { id: mediaId } });
    if (!m) throw new Error('Title not found');
    const data = {
        title: meta.title || m.title,
        description: meta.description || m.description,
        tagline: meta.tagline || m.tagline,
        releaseYear: meta.releaseYear || m.releaseYear,
        genres: meta.genres || m.genres,
        maturity: meta.maturity || m.maturity,
        rating: meta.rating ?? m.rating,
        cast: meta.cast || m.cast,
        director: meta.director || m.director,
        tmdbId: meta.tmdbId,
        imdbId: meta.imdbId || m.imdbId,
        trailerUrl: m.trailerUrl && !/^https?:/i.test(m.trailerUrl) ? m.trailerUrl : (meta.trailerUrl || m.trailerUrl),
        poster: meta.poster || m.poster,
        backdrop: meta.backdrop || m.backdrop,
        thumbnail: meta.thumbnail || m.thumbnail,
        logoUrl: meta.logoUrl || m.logoUrl
    };
    if (m.type === 'movie' && meta.duration) data.duration = meta.duration;
    if (isGenericCategory(m.category)) data.category = splitGenres(meta.genres)[0] || m.category;
    const updated = await prisma.media.update({ where: { id: mediaId }, data });
    if (m.type === 'series') await fillEpisodesFromTmdb(mediaId, meta.tmdbId);
    return updated;
}

export async function fillEpisodesFromTmdb(seriesId, tvId) {
    const eps = await prisma.media.findMany({ where: { parentId: seriesId, type: 'episode' } });
    const seasons = [...new Set(eps.map(e => e.season || 1))];
    for (const s of seasons) {
        let list = [];
        try { list = await tmdb.season(tvId, s); } catch { continue; }
        for (const e of eps.filter(x => (x.season || 1) === s)) {
            const hit = list.find(x => x.episode === e.order);
            if (!hit) continue;
            const generic = !e.title || /^(episode|episodio|épisode|bölüm)\s*\d+$/i.test(e.title.trim());
            await prisma.media.update({
                where: { id: e.id },
                data: {
                    title: generic && hit.title ? hit.title : e.title,
                    description: e.description || hit.description,
                    thumbnail: e.thumbnail && !e.thumbnail.includes('/auto-') ? e.thumbnail : (hit.still || e.thumbnail),
                    duration: e.duration || hit.duration
                }
            });
        }
    }
}

// ---------------------------------------------------------------- torrents
async function attachSubtitles(mediaId, subFiles) {
    if (!subFiles.length) return;
    const existing = await prisma.subtitle.findMany({ where: { mediaId } });
    for (const f of subFiles) {
        const p = 'dl:' + f.disk;
        if (existing.some(s => s.path === p)) continue;
        const g = guessSubtitleInfo(f.name);
        const label = (languageName(g.lang, 'en') || path.basename(f.name).replace(/\.[^.]+$/, '')) +
            (g.forced ? ' (Forced)' : '') + (g.sdh ? ' (SDH)' : '');
        await prisma.subtitle.create({ data: { mediaId, lang: g.lang, label, path: p } });
    }
}

const stem = (n) => path.basename(String(n)).replace(/\.[^.]+$/, '').toLowerCase();

/**
 * Creates or updates library entries for a torrent. Safe to call repeatedly
 * (on start so titles appear immediately, and again on completion).
 * Returns the ids of media rows that point at files.
 */
export async function importTorrent(row) {
    const files = safeJson(row.files, []);
    const selected = new Set(safeJson(row.selected, []));
    const chosen = files.filter(f => selected.has(f.index));
    const videos = chosen.filter(f => isVideoFile(f.name) && !isSampleFile(f.name, f.length));
    if (!videos.length) return [];
    const subs = chosen.filter(f => isSubtitleFile(f.name));
    const settings = await getSettings();
    const t = makeT(loadLocale(pickLang(settings.LANGUAGE)));
    const match = safeJson(row.match);
    const parsed = parseRelease(row.name);
    let meta = null;
    if (match && match.tmdbId) {
        try { meta = await tmdb.details(match.type, match.tmdbId); } catch (e) { console.warn(`[import] TMDB lookup failed: ${e.message}`); }
    }
    const existing = await prisma.media.findMany({ where: { torrentId: row.id } });

    if (row.kind === 'series') {
        let eps = detectEpisodes(videos);
        if (!eps.length) {
            eps = [...videos].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
                .map((v, i) => ({ index: v.index, season: parsed.season || 1, episode: i + 1, name: v.name }));
        }
        let series = existing.find(m => m.type === 'series') || null;
        if (!series && meta && meta.tmdbId) series = await prisma.media.findFirst({ where: { type: 'series', tmdbId: meta.tmdbId } });
        if (!series) {
            const wanted = normText((meta && meta.title) || parsed.title);
            series = (await prisma.media.findMany({ where: { type: 'series' } })).find(s => normText(s.title) === wanted) || null;
        }
        if (!series) {
            series = await prisma.media.create({ data: { ...metaFields(meta, parsed, 'series', t), type: 'series', torrentId: row.id } });
        }
        const tvId = (meta && meta.tmdbId) || series.tmdbId;
        const seasonCache = new Map();
        const ids = [];
        for (const e of eps) {
            const file = videos.find(v => v.index === e.index);
            let epMeta = null;
            if (tvId && (await tmdb.tmdbEnabled())) {
                if (!seasonCache.has(e.season)) seasonCache.set(e.season, await tmdb.season(tvId, e.season).catch(() => []));
                epMeta = seasonCache.get(e.season).find(x => x.episode === e.episode) || null;
            }
            const link = { type: 'episode', parentId: series.id, season: e.season, order: e.episode, path: 'dl:' + file.disk, torrentId: row.id, fileIndex: e.index, category: 'Episode' };
            let ep = existing.find(x => x.type === 'episode' && x.fileIndex === e.index)
                || await prisma.media.findFirst({ where: { type: 'episode', parentId: series.id, season: e.season, order: e.episode } });
            if (!ep) {
                ep = await prisma.media.create({
                    data: {
                        ...link,
                        title: (epMeta && epMeta.title) || `${t('player.episode')} ${e.episode}`,
                        description: (epMeta && epMeta.description) || '',
                        thumbnail: (epMeta && epMeta.still) || null,
                        duration: (epMeta && epMeta.duration) || null
                    }
                });
            } else if (!ep.path || ep.torrentId === row.id || ep.path === link.path || !fileExists(ep.path)) {
                ep = await prisma.media.update({ where: { id: ep.id }, data: link });
            } else {
                continue; // an existing episode with a working file wins
            }
            ids.push(ep.id);
            const epSubs = subs.filter(s => {
                const p = parseRelease(s.name);
                return (p.episode === e.episode && (p.season ?? e.season) === e.season) || stem(s.name).startsWith(stem(file.name));
            });
            await attachSubtitles(ep.id, epSubs);
        }
        return ids;
    }

    // movie (or "other": treat the biggest video as a movie)
    const main = videos.reduce((a, b) => (b.length > a.length ? b : a));
    let movie = existing.find(m => m.type === 'movie') || null;
    const link = { path: 'dl:' + main.disk, torrentId: row.id, fileIndex: main.index };
    if (!movie) {
        // Re-adding a torrent (or downloading a title whose file went missing) must not
        // create a duplicate: re-link the library entry that points at the same movie.
        const fields = metaFields(meta, parsed, 'movie', t);
        const movies = await prisma.media.findMany({ where: { type: 'movie' } });
        const fileGone = (m) => !m.path || (!/^https?:/i.test(m.path) && !fileExists(m.path));
        const sameYear = (m) => !fields.releaseYear || !m.releaseYear || m.releaseYear === fields.releaseYear;
        const reuse = movies.find(m => m.path === link.path)
            || (fields.tmdbId ? movies.find(m => m.tmdbId === fields.tmdbId && fileGone(m)) : null)
            || movies.find(m => normText(m.title) === normText(fields.title) && sameYear(m) && fileGone(m));
        movie = reuse
            ? await prisma.media.update({ where: { id: reuse.id }, data: link })
            : await prisma.media.create({ data: { ...fields, ...link, type: 'movie' } });
    } else if (movie.fileIndex !== main.index || movie.path !== link.path) {
        movie = await prisma.media.update({ where: { id: movie.id }, data: link });
    }
    await attachSubtitles(movie.id, subs);
    return [movie.id];
}

/** Uses artwork shipped inside a torrent (poster.jpg, fanart.jpg, logo.png…) when a title has none. */
export async function applyTorrentArtwork(row) {
    const files = safeJson(row.files, []);
    const selected = new Set(safeJson(row.selected, []));
    const arts = files.filter(f => selected.has(f.index) && isArtworkFile(f.name, f.length));
    if (!arts.length) return;
    const titles = await prisma.media.findMany({ where: { torrentId: row.id, type: { in: ['movie', 'series'] } } });
    for (const m of titles) {
        const data = {};
        for (const f of arts) {
            const abs = path.join(DOWNLOAD_DIR, f.disk || f.path);
            let size = -1;
            try { size = fs.statSync(abs).size; } catch { continue; }
            if (size !== f.length) continue;
            const base = path.basename(f.name).toLowerCase();
            const col = /^(fanart|backdrop|background|landscape)/.test(base) ? 'backdrop'
                : /logo/.test(base) ? 'logoUrl' : /^(banner|thumb)/.test(base) ? 'thumbnail' : 'poster';
            if (m[col] || data[col]) continue;
            const rel = `images/t${row.id}-${col}-${Date.now().toString(36)}${path.extname(base)}`;
            fs.copyFileSync(abs, path.join(UPLOAD_DIR, rel));
            data[col] = '/uploads/' + rel;
        }
        if (Object.keys(data).length) await prisma.media.update({ where: { id: m.id }, data });
    }
}
