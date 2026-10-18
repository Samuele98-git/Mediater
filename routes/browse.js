// Browse pages: home, TV shows, movies, genres, New & Popular, My List,
// search and the player.
import express from 'express';
import prisma from '../lib/prisma.js';
import engine from '../lib/torrents.js';
import { isAuth, isAdmin, requireProfile, displayName, ownerAdmin } from '../middleware/auth.js';
import {
    loadLibrary, loadProfileState, buildAffinity, buildRows, titleCard, pickBillboard, allGenres,
    hasGenre, topTen, continueWatching, searchTitles, isFinished, similarTitles
} from '../lib/library.js';

const router = express.Router();
const DAY = 86_400_000;

/**
 * The catalog as this profile sees it. Titles still downloading are only shown
 * to the admin (with their progress); everyone else gets a plain Netflix-like
 * library where a title appears once it's ready to watch.
 */
async function visibleLibrary(req) {
    const downloading = engine.enabled ? engine.downloadingMedia() : new Map();
    const admin = ownerAdmin(req);
    const lib = await loadLibrary(req.profile, { hide: admin ? null : downloading });
    return { lib, downloading: admin ? downloading : new Map() };
}

export async function browseContext(req) {
    const { lib, downloading } = await visibleLibrary(req);
    const state = await loadProfileState(req.profile.id);
    const aff = buildAffinity(lib, state);
    return { lib, state, aff, downloading };
}

export function cardsFor(ids, ctx) {
    const out = {};
    for (const id of ids) {
        const m = ctx.lib.byId.get(id);
        if (m && ctx.lib.visibleIds.has(id)) out[id] = titleCard(m, ctx.lib, ctx.state, ctx.aff, ctx.downloading);
    }
    return out;
}

function markTop10(rows, titles) {
    for (const r of rows.filter(x => x.kind === 'top10')) {
        r.items.forEach((it, i) => { if (titles[it.id] && !titles[it.id].top10) titles[it.id].top10 = i + 1; });
    }
}

async function renderBrowse(req, res, { type = null, genre = null, pageType, openTitle = null }) {
    // ?jbv=<id> opens the details modal on load (same convention as Netflix)
    openTitle = openTitle || parseInt(req.query.jbv, 10) || null;
    const ctx = await browseContext(req);
    const t = res.locals.t;
    const rows = await buildRows(ctx.lib, ctx.state, {
        type, genre, t, profileName: displayName(req.profile), appName: res.locals.APP_NAME
    });
    const pool = ctx.lib.titles.filter(m => (!type || m.type === type) && (!genre || hasGenre(m, genre)));
    const heroMedia = pickBillboard(pool);
    const ids = new Set(rows.flatMap(r => r.items.map(i => i.id)));
    if (heroMedia) ids.add(heroMedia.id);
    if (openTitle) ids.add(openTitle);
    const titles = cardsFor(ids, ctx);
    markTop10(rows, titles);
    res.render('browse', {
        rows, titles, pageType, genre, openTitle,
        hero: heroMedia ? titles[heroMedia.id] : null,
        genres: allGenres(type ? ctx.lib.titles.filter(m => m.type === type) : ctx.lib.titles).slice(0, 40),
        emptyLibrary: ctx.lib.titles.length === 0
    });
}

const page = (fn) => (req, res, next) => fn(req, res).catch(next);

router.get('/', isAuth, requireProfile, page((req, res) => renderBrowse(req, res, { pageType: 'home' })));
router.get(['/browse/tv', '/series'], isAuth, requireProfile, page((req, res) => renderBrowse(req, res, { type: 'series', pageType: 'series' })));
router.get(['/browse/movies', '/movies'], isAuth, requireProfile, page((req, res) => renderBrowse(req, res, { type: 'movie', pageType: 'movies' })));
router.get('/browse/genre/:genre', isAuth, requireProfile, page((req, res) => {
    const type = req.query.type === 'movie' || req.query.type === 'series' ? req.query.type : null;
    return renderBrowse(req, res, { genre: req.params.genre, type, pageType: type === 'movie' ? 'movies' : type === 'series' ? 'series' : 'genre' });
}));
router.get('/title/:id', isAuth, requireProfile, page((req, res) => {
    return renderBrowse(req, res, { pageType: 'home', openTitle: parseInt(req.params.id, 10) || null });
}));

router.get('/latest', isAuth, requireProfile, page(async (req, res) => {
    const ctx = await browseContext(req);
    const t = res.locals.t;
    const app = res.locals.APP_NAME;
    const all = ctx.lib.titles;
    const byNew = [...all].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const rows = [];
    const add = (key, kind, title, list) => { if (list.length) rows.push({ key, kind, title, items: list.map(m => ({ id: m.id })) }); };
    add('new', 'standard', t('rows.new_on', { app }), byNew.filter(m => Date.now() - new Date(m.created_at) < 60 * DAY).slice(0, 30));
    if (all.filter(m => m.type === 'series').length >= 4) add('top-series', 'top10', t('rows.top10_shows', { app }), await topTen(ctx.lib, 'series'));
    if (all.filter(m => m.type === 'movie').length >= 4) add('top-movie', 'top10', t('rows.top10_movies', { app }), await topTen(ctx.lib, 'movie'));
    add('trending', 'standard', t('rows.trending_now'), all.filter(m => m.trending));
    // Series with episodes added in the last 30 days
    const freshEps = new Set();
    for (const [sid, eps] of ctx.lib.epBySeries) if (eps.some(e => Date.now() - new Date(e.created_at) < 30 * DAY)) freshEps.add(sid);
    add('new-episodes', 'standard', t('rows.new_episodes'), all.filter(m => freshEps.has(m.id)));
    if (!rows.length) add('all', 'standard', t('rows.more_to_explore'), byNew.slice(0, 30));
    const ids = new Set(rows.flatMap(r => r.items.map(i => i.id)));
    const titles = cardsFor(ids, ctx);
    markTop10(rows, titles);
    for (const id of freshEps) if (titles[id]) titles[id].newEpisodes = true;
    res.render('browse', { rows, titles, pageType: 'latest', genre: null, openTitle: null, hero: null, genres: [], emptyLibrary: all.length === 0, pageTitle: t('nav.new_popular') });
}));

router.get(['/browse/my-list', '/mylist'], isAuth, requireProfile, page(async (req, res) => {
    const ctx = await browseContext(req);
    const items = ctx.state.listOrder.filter(id => ctx.lib.visibleIds.has(id));
    res.render('grid', { mode: 'mylist', q: '', items, titles: cardsFor(items, ctx) });
}));

router.get('/search', isAuth, requireProfile, page(async (req, res) => {
    const ctx = await browseContext(req);
    const q = String(req.query.q || '').trim().slice(0, 100);
    const found = q ? searchTitles(ctx.lib, q) : [];
    const results = found.map(m => m.id);
    const related = q ? allGenres(found).slice(0, 8).map(g => g.name) : [];
    // When there's no query, suggest popular titles like Netflix's "Top Searches".
    const suggestions = q ? [] : (await topTen(ctx.lib, null)).map(m => m.id);
    const ids = [...results, ...suggestions];
    const genres = allGenres(ctx.lib.titles).slice(0, 12).map(g => g.name);
    res.render('grid', { mode: 'search', q, items: results, suggestions, genres, related, titles: cardsFor(ids, ctx) });
}));

// ------------------------------------------------------------ player
const slimEpisode = (e, fallbackImg) => ({
    id: e.id, season: e.season || 1, order: e.order, title: e.title, description: e.description || '',
    duration: e.duration, thumbnail: e.thumbnail || fallbackImg || ''
});

router.get('/watch/:id(\\d+)', isAuth, requireProfile, page(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const m = id > 0 && id <= 2147483647 ? await prisma.media.findUnique({ where: { id } }) : null;
    if (!m) return res.status(404).render('error', { code: 404 });
    const { lib } = await visibleLibrary(req);
    const titleId = m.type === 'episode' ? m.parentId : m.id;
    if (!lib.visibleIds.has(titleId) || (m.type === 'episode' && !lib.epById.has(m.id))) return res.redirect('/');

    if (m.type === 'series') {
        const state = await loadProfileState(req.profile.id);
        const cw = continueWatching(lib, state).find(x => x.title.id === m.id);
        const eps = lib.epBySeries.get(m.id) || [];
        const target = cw ? cw.playId : (eps[0] && eps[0].id);
        return res.redirect(target ? '/watch/' + target : '/title/' + m.id);
    }
    const parent = m.type === 'episode' ? lib.byId.get(m.parentId) : null;
    const episodes = parent ? (lib.epBySeries.get(parent.id) || []) : [];
    const idx = episodes.findIndex(e => e.id === m.id);
    const nextEpisode = idx >= 0 && episodes[idx + 1] ? episodes[idx + 1] : null;
    const progress = await prisma.watchProgress.findUnique({ where: { userId_mediaId: { userId: req.profile.id, mediaId: m.id } } });
    let resume = progress && !isFinished(progress, m) && progress.position > 10 ? progress.position : 0;
    if (req.query.t) resume = Math.max(0, parseFloat(req.query.t) || 0);
    if (req.query.restart) resume = 0;
    const fallbackImg = parent ? (parent.thumbnail || parent.backdrop) : '';
    // Nothing plays next: the end screen suggests similar titles, like Netflix.
    const similar = nextEpisode ? [] : similarTitles(parent || m, lib, 6).slice(0, 3).map(s => ({
        id: s.id, title: s.title, img: s.backdrop || s.thumbnail || s.poster || '', year: s.releaseYear || '', maturity: s.maturity || ''
    }));
    res.render('watch', {
        similar,
        media: { id: m.id, title: m.title, type: m.type, season: m.season || 1, order: m.order, description: m.description || '', maturity: (parent || m).maturity || '', year: (parent || m).releaseYear || '', backdrop: m.backdrop || m.thumbnail || fallbackImg || '' },
        parent: parent ? { id: parent.id, title: parent.title } : null,
        episodes: episodes.map(e => slimEpisode(e, fallbackImg)),
        nextEpisode: nextEpisode ? slimEpisode(nextEpisode, fallbackImg) : null,
        resume,
        markers: {
            introStart: m.introStart ?? (parent ? parent.introStart : null),
            introEnd: m.introEnd ?? (parent ? parent.introEnd : null),
            creditsStart: m.creditsStart ?? null
        },
        source: 'm/' + m.id,
        preview: false,
        backUrl: parent ? '/title/' + parent.id : '/title/' + m.id
    });
}));

router.get('/watch/t/:tid(\\d+)/:fi(\\d+)', isAdmin, (req, res) => {
    const tid = parseInt(req.params.tid, 10), fi = parseInt(req.params.fi, 10);
    const info = engine.fileInfo(tid, fi);
    if (!info) return res.status(404).render('error', { code: 404 });
    res.render('watch', {
        media: { id: null, title: info.name, type: 'movie', description: '', maturity: '', year: '', backdrop: '' },
        parent: null, episodes: [], nextEpisode: null, resume: 0,
        markers: {}, source: `t/${tid}/${fi}`, preview: true, backUrl: '/downloads'
    });
});

export default router;
