// Minimal TMDB (themoviedb.org) client used to fill in posters, backdrops,
// logos, trailers, cast and episode info. Needs a free API key (v3 key or
// v4 read-access token) in Admin -> Settings or the TMDB_API_KEY env var.
import { getSettings } from './settings.js';

// Overridable for proxies / testing.
const API = (process.env.TMDB_API_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
const IMG = (process.env.TMDB_IMAGE_URL || 'https://image.tmdb.org/t/p').replace(/\/+$/, '') + '/';
const LANG_MAP = { en: 'en-US', it: 'it-IT', es: 'es-ES', fr: 'fr-FR', tr: 'tr-TR' };
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

export const img = (p, size = 'w780') => (p ? IMG + size + p : null);

export async function tmdbConfig() {
    const s = await getSettings();
    const key = String(s.TMDB_API_KEY || process.env.TMDB_API_KEY || '').trim();
    const lang2 = s.LANGUAGE || 'en';
    return { key, lang2, language: LANG_MAP[lang2] || 'en-US', region: String(s.TMDB_REGION || 'US').toUpperCase() };
}

export async function tmdbEnabled() {
    return !!(await tmdbConfig()).key;
}

async function call(pathname, params = {}) {
    const cfg = await tmdbConfig();
    if (!cfg.key) throw new Error('TMDB API key is not configured');
    const url = new URL(API + pathname);
    const headers = { accept: 'application/json' };
    if (cfg.key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + cfg.key;
    else url.searchParams.set('api_key', cfg.key);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const cacheKey = url.toString() + '|' + (headers.Authorization || '');
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
        let msg = '';
        try { msg = (await res.json()).status_message || ''; } catch { /* ignore */ }
        throw new Error(`TMDB ${res.status}${msg ? ': ' + msg : ''}`);
    }
    const data = await res.json();
    cache.set(cacheKey, { at: Date.now(), data });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return data;
}

const tmdbType = (type) => (type === 'series' || type === 'tv') ? 'tv' : 'movie';

export async function search(query, { type, year } = {}) {
    const cfg = await tmdbConfig();
    const t = type === 'movie' ? 'movie' : (type === 'series' || type === 'tv') ? 'tv' : 'multi';
    const params = { query, include_adult: 'false', language: cfg.language, page: 1 };
    if (year && t === 'movie') params.year = year;
    if (year && t === 'tv') params.first_air_date_year = year;
    const data = await call(`/search/${t}`, params);
    return (data.results || [])
        .filter(r => t !== 'multi' || r.media_type === 'movie' || r.media_type === 'tv')
        .map(r => {
            const mt = t === 'multi' ? r.media_type : t;
            const date = r.release_date || r.first_air_date || '';
            return {
                tmdbId: r.id,
                type: mt === 'tv' ? 'series' : 'movie',
                title: r.title || r.name || '',
                originalTitle: r.original_title || r.original_name || '',
                year: date ? parseInt(date.slice(0, 4), 10) : null,
                overview: r.overview || '',
                poster: img(r.poster_path, 'w342'),
                backdrop: img(r.backdrop_path, 'w780'),
                rating: r.vote_average || null,
                popularity: r.popularity || 0
            };
        });
}

const normTitle = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

function similarity(a, b) {
    a = normTitle(a); b = normTitle(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.75;
    const A = new Set(a.split(' ')), B = new Set(b.split(' '));
    const inter = [...A].filter(x => B.has(x)).length;
    return inter / Math.max(A.size, B.size) * 0.7;
}

/** Best TMDB match for a parsed release name ({ title, year }). */
export async function autoMatch({ title, year }, kind) {
    if (!title) return null;
    const type = kind === 'series' ? 'series' : kind === 'movie' ? 'movie' : undefined;
    let results = await search(title, { type, year });
    if (!results.length && year) results = await search(title, { type });
    if (!results.length) return null;
    const scored = results.slice(0, 10).map(r => {
        const sim = Math.max(similarity(title, r.title), similarity(title, r.originalTitle));
        const yr = year && r.year ? (r.year === year ? 1 : Math.abs(r.year - year) === 1 ? 0.5 : 0) : 0.3;
        const pop = Math.min((r.popularity || 0) / 50, 1);
        return { r, score: sim * 2 + yr + pop * 0.4 };
    }).sort((a, b) => b.score - a.score);
    return scored[0].score >= 1.2 ? scored[0].r : null;
}

function pickCertification(d, region, isTv) {
    const regions = [region, 'US'];
    if (isTv) {
        const list = (d.content_ratings && d.content_ratings.results) || [];
        for (const r of regions) {
            const hit = list.find(x => x.iso_3166_1 === r && x.rating);
            if (hit) return hit.rating;
        }
        return null;
    }
    const list = (d.release_dates && d.release_dates.results) || [];
    for (const r of regions) {
        const entry = list.find(x => x.iso_3166_1 === r);
        if (!entry) continue;
        const dates = (entry.release_dates || []).filter(x => x.certification);
        const best = dates.find(x => x.type === 3) || dates[0];
        if (best) return best.certification;
    }
    return null;
}

function pickLogo(d, lang2) {
    const logos = (d.images && d.images.logos) || [];
    if (!logos.length) return null;
    const rank = (l) => (l.iso_639_1 === lang2 ? 3 : l.iso_639_1 === 'en' ? 2 : l.iso_639_1 == null ? 1 : 0);
    const best = [...logos].sort((a, b) => rank(b) - rank(a) || (b.vote_average || 0) - (a.vote_average || 0))[0];
    return best ? img(best.file_path, best.file_path.endsWith('.svg') ? 'original' : 'w500') : null;
}

function pickTrailer(d, lang2) {
    const vids = ((d.videos && d.videos.results) || []).filter(v => v.site === 'YouTube' && v.key);
    if (!vids.length) return null;
    const rank = (v) => (v.type === 'Trailer' ? 4 : v.type === 'Teaser' ? 2 : 0) + (v.official ? 1 : 0) + (v.iso_639_1 === lang2 ? 2 : 0);
    const best = [...vids].sort((a, b) => rank(b) - rank(a))[0];
    return 'https://www.youtube.com/watch?v=' + best.key;
}

/** Full details mapped onto Media fields. */
export async function details(type, id) {
    const cfg = await tmdbConfig();
    const t = tmdbType(type);
    const append = t === 'movie'
        ? 'videos,images,release_dates,credits'
        : 'videos,images,content_ratings,credits,external_ids';
    const d = await call(`/${t}/${id}`, {
        language: cfg.language,
        append_to_response: append,
        include_image_language: `${cfg.lang2},en,null`,
        include_video_language: `${cfg.lang2},en,null`
    });
    const date = d.release_date || d.first_air_date || '';
    const isTv = t === 'tv';
    const crew = (d.credits && d.credits.crew) || [];
    const director = isTv
        ? (d.created_by || []).map(c => c.name).slice(0, 3).join(', ')
        : crew.filter(c => c.job === 'Director').map(c => c.name).slice(0, 3).join(', ');
    const runtime = isTv ? ((d.episode_run_time && d.episode_run_time[0]) || (d.last_episode_to_air && d.last_episode_to_air.runtime) || null) : (d.runtime || null);
    return {
        tmdbId: d.id,
        type: isTv ? 'series' : 'movie',
        title: d.title || d.name || '',
        description: d.overview || '',
        tagline: d.tagline || '',
        releaseYear: date ? parseInt(date.slice(0, 4), 10) : null,
        duration: runtime,
        genres: (d.genres || []).map(g => g.name).join(', '),
        maturity: pickCertification(d, cfg.region, isTv),
        rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
        poster: img(d.poster_path, 'w500'),
        backdrop: img(d.backdrop_path, 'w1280'),
        thumbnail: img(d.backdrop_path, 'w780'),
        logoUrl: pickLogo(d, cfg.lang2),
        trailerUrl: pickTrailer(d, cfg.lang2),
        cast: ((d.credits && d.credits.cast) || []).slice(0, 8).map(c => c.name).join(', '),
        director,
        imdbId: d.imdb_id || (d.external_ids && d.external_ids.imdb_id) || null,
        seasons: isTv ? (d.seasons || []).filter(s => s.season_number > 0).map(s => ({
            season: s.season_number, name: s.name, episodes: s.episode_count, poster: img(s.poster_path, 'w342')
        })) : []
    };
}

export async function season(tvId, number) {
    const cfg = await tmdbConfig();
    const d = await call(`/tv/${tvId}/season/${number}`, { language: cfg.language });
    return (d.episodes || []).map(e => ({
        season: e.season_number,
        episode: e.episode_number,
        title: e.name || '',
        description: e.overview || '',
        still: img(e.still_path, 'w500'),
        duration: e.runtime || null,
        airDate: e.air_date || null
    }));
}
